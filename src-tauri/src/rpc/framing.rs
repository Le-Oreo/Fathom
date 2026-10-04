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
