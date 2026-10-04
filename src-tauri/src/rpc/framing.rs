use prost::Message;

use super::proto::pb;

pub const MAX_FRAME: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /* more than 5 bytes for a u32 length */
    VarintTooLong,
    TooLarge(usize),
    Decode(String),
}

pub fn encode_varint(mut v: u32, out: &mut Vec<u8>) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

pub fn decode_varint(buf: &[u8]) -> Result<Option<(u32, usize)>, FrameError> {
    let mut v: u64 = 0;
    for (i, &b) in buf.iter().enumerate() {
        if i >= 5 {
            return Err(FrameError::VarintTooLong);
        }
        v |= u64::from(b & 0x7f) << (7 * i);
        if b & 0x80 == 0 {
            return u32::try_from(v)
                .map(|v| Some((v, i + 1)))
                .map_err(|_| FrameError::VarintTooLong);
        }
    }
    if buf.len() >= 5 {
        return Err(FrameError::VarintTooLong);
    }
    Ok(None)
}

pub fn encode(msg: &pb::Main) -> Vec<u8> {
    let body = msg.encode_to_vec();
    let mut out = Vec::with_capacity(body.len() + 5);
    encode_varint(body.len() as u32, &mut out);
    out.extend_from_slice(&body);
    out
}

#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<pb::Main>, FrameError> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        let mut at = 0;
        while let Some((len, n)) = decode_varint(&self.buf[at..])? {
            let len = len as usize;
            if len > MAX_FRAME {
                return Err(FrameError::TooLarge(len));
            }
            let start = at + n;
            if self.buf.len() < start + len {
                break;
            }
            let msg = pb::Main::decode(&self.buf[start..start + len])
                .map_err(|e| FrameError::Decode(e.to_string()))?;
            out.push(msg);
            at = start + len;
        }
        self.buf.drain(..at);
        Ok(out)
    }

    pub fn push_until(
        &mut self,
        data: &[u8],
        stop: u32,
    ) -> Result<(Vec<pb::Main>, Option<Vec<u8>>), FrameError> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        let mut at = 0;
        while let Some((len, n)) = decode_varint(&self.buf[at..])? {
            let len = len as usize;
            if len > MAX_FRAME {
                return Err(FrameError::TooLarge(len));
            }
            let start = at + n;
            if self.buf.len() < start + len {
                break;
            }
            let msg = pb::Main::decode(&self.buf[start..start + len])
                .map_err(|e| FrameError::Decode(e.to_string()))?;
            at = start + len;
            let done = msg.command_id == stop && !msg.has_next;
            out.push(msg);
            if done {
                let rest = self.buf[at..].to_vec();
                self.buf.clear();
                return Ok((out, Some(rest)));
            }
        }
        self.buf.drain(..at);
        Ok((out, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::proto::{pb, pb_system};

    fn ping(id: u32, data: &[u8]) -> pb::Main {
        pb::Main {
            command_id: id,
            content: Some(pb::main::Content::SystemPingRequest(
                pb_system::PingRequest {
                    data: data.to_vec(),
                },
            )),
            ..Default::default()
        }
    }

    #[test]
    fn varints_of_1_to_5_bytes() {
        let cases: [(u32, usize); 10] = [
            (0, 1),
            (1, 1),
            (127, 1),
            (128, 2),
            (16_383, 2),
            (16_384, 3),
            (2_097_151, 3),
            (2_097_152, 4),
            (268_435_455, 4),
            (u32::MAX, 5),
        ];
        for (v, len) in cases {
            let mut out = Vec::new();
            encode_varint(v, &mut out);
            assert_eq!(out.len(), len, "length of {v}");
            assert_eq!(decode_varint(&out), Ok(Some((v, len))), "round trip of {v}");
            assert_eq!(decode_varint(&out[..len - 1]), Ok(None), "{v} cut short");
        }
    }

    #[test]
    fn varint_longer_than_5_bytes_is_an_error() {
        assert_eq!(
            decode_varint(&[0x80, 0x80, 0x80, 0x80, 0x80, 0x01]),
            Err(FrameError::VarintTooLong)
        );
        assert_eq!(
            decode_varint(&[0x80, 0x80, 0x80, 0x80, 0x80]),
            Err(FrameError::VarintTooLong)
        );
        /* five bytes but bigger than a u32 */
        assert_eq!(
            decode_varint(&[0xff, 0xff, 0xff, 0xff, 0x7f]),
            Err(FrameError::VarintTooLong)
        );
    }

    #[test]
    fn frame_split_across_reads() {
        let msg = ping(7, &[1; 300]); /* a 2-byte length */
        let bytes = encode(&msg);
        let mut d = Decoder::default();
        for (i, b) in bytes.iter().enumerate() {
            let got = d.push(std::slice::from_ref(b)).unwrap();
            if i + 1 < bytes.len() {
                assert!(got.is_empty(), "nothing until the last byte (at {i})");
            } else {
                assert_eq!(got, vec![msg.clone()]);
            }
        }
    }

    #[test]
    fn several_frames_in_one_read() {
        let msgs: Vec<_> = (1..=4)
            .map(|i| ping(i, &vec![i as u8; i as usize * 50]))
            .collect();
        let mut all: Vec<u8> = msgs.iter().flat_map(encode).collect();
        let fifth = encode(&ping(5, b"five"));
        all.extend_from_slice(&fifth[..3]);
        let mut d = Decoder::default();
        assert_eq!(d.push(&all).unwrap(), msgs);
        assert_eq!(d.push(&fifth[3..]).unwrap(), vec![ping(5, b"five")]);
    }

    #[test]
    fn huge_length_means_out_of_step() {
        let mut bytes = Vec::new();
        encode_varint((MAX_FRAME + 1) as u32, &mut bytes);
        assert_eq!(
            Decoder::default().push(&bytes),
            Err(FrameError::TooLarge(MAX_FRAME + 1))
        );
    }
}
