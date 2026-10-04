use crate::error::{DeviceError, ErrorCode};
use crate::rpc::proto::{pb, pb_app};
use crate::rpc::{Content, RpcError, Session, REQUEST_TIMEOUT};

pub async fn start(s: &Session, name: &str, args: &str) -> Result<(), DeviceError> {
    let req = Content::AppStartRequest(pb_app::StartRequest {
        name: name.into(),
        args: args.into(),
    });
    let detail = if args.is_empty() {
        name.to_string()
    } else {
        format!("{name} {args}")
    };
    match s.request(req, &detail, REQUEST_TIMEOUT).await {
        Ok(_) => Ok(()),
        Err(RpcError::Status(st)) if st == pb::CommandStatus::ErrorInvalidParameters as i32 => {
            Err(DeviceError::new(ErrorCode::NoApp, name))
        }
        Err(RpcError::Status(st)) if st == pb::CommandStatus::ErrorAppCantStart as i32 => {
            Err(DeviceError::new(ErrorCode::AppFailed, name))
        }
        Err(e) => Err(e.into()),
    }
}
