use std::sync::Arc;

use crate::rpc::proto::pb_gui::{self, InputKey, InputType};
use crate::rpc::{Content, RpcError, Session, REQUEST_TIMEOUT};

pub const FRAME_BYTES: usize = 1024;

pub type OnFrame = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

pub async fn start(session: &Session, on_frame: OnFrame) -> Result<u64, RpcError> {
    let id = session.set_listener(Arc::new(move |m| {
        if let Some(Content::GuiScreenFrame(f)) = m.content {
            on_frame(frame_bytes(f));
        }
    }));
    let req = Content::GuiStartScreenStreamRequest(pb_gui::StartScreenStreamRequest {});
    if let Err(e) = session
        .request(req, "ScreenFrame stream", REQUEST_TIMEOUT)
        .await
    {
        session.clear_listener(id);
        return Err(e);
    }
    Ok(id)
}

pub async fn stop(session: &Session, id: u64) -> Result<(), RpcError> {
    if !session.clear_listener(id) {
        return Ok(());
    }
    let req = Content::GuiStopScreenStreamRequest(pb_gui::StopScreenStreamRequest {});
    session.request(req, "", REQUEST_TIMEOUT).await.map(|_| ())
}

pub fn frame_bytes(f: pb_gui::ScreenFrame) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_BYTES + 1);
    out.push(u8::try_from(f.orientation).unwrap_or(0).min(3));
    out.extend(f.data.iter().take(FRAME_BYTES));
    out.resize(FRAME_BYTES + 1, 0);
    out
}

pub fn parse_key(key: &str) -> Option<InputKey> {
    Some(match key {
        "up" => InputKey::Up,
        "down" => InputKey::Down,
        "left" => InputKey::Left,
        "right" => InputKey::Right,
        "ok" => InputKey::Ok,
        "back" => InputKey::Back,
        _ => return None,
    })
}

pub fn parse_type(kind: &str) -> Option<InputType> {
    Some(match kind {
        "press" => InputType::Press,
        "release" => InputType::Release,
        "short" => InputType::Short,
        "long" => InputType::Long,
        "repeat" => InputType::Repeat,
        _ => return None,
    })
}

pub async fn input(session: &Session, key: InputKey, kind: InputType) -> Result<(), RpcError> {
    let detail = format!(
        "{}, {} press",
        key.as_str_name(),
        kind.as_str_name().to_lowercase()
    );
    let req = Content::GuiSendInputEventRequest(pb_gui::SendInputEventRequest {
        key: key as i32,
        r#type: kind as i32,
    });
    let logged = matches!(kind, InputType::Short | InputType::Long);
    session
        .request_quiet(
            req,
            if logged { Some(&detail) } else { None },
            REQUEST_TIMEOUT,
        )
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_always_hold_orientation_and_1024_bytes() {
        let f = frame_bytes(pb_gui::ScreenFrame {
            data: vec![0xff; 10],
            orientation: 2,
        });
        assert_eq!((f.len(), f[0], f[1], f[11]), (1025, 2, 0xff, 0));
        let f = frame_bytes(pb_gui::ScreenFrame {
            data: vec![1; 2000],
            orientation: 9,
        });
        assert_eq!((f.len(), f[0]), (1025, 3));
    }

    #[test]
    fn keys_and_types_by_name() {
        assert_eq!(parse_key("ok"), Some(InputKey::Ok));
        assert_eq!(parse_key("menu"), None);
        assert_eq!(parse_type("repeat"), Some(InputType::Repeat));
        assert_eq!(parse_type("tap"), None);
    }
}
