use serde::Serialize;

use crate::rpc::proto::pb::CommandStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    Disconnected,
    Timeout,
    NotFound,
    Exists,
    NotEmpty,
    InvalidName,
    Locked,
    NoSd,
    Busy,
    PortBusy,
    Permission,
    NoAnswer,
    Cancelled,
    /* the firmware has no app by that name */
    NoApp,
    AppFailed,
    Offline,
    /* not enough free space for what's about to be copied */
    NoRoom,
    /* the update package is damaged, or isn't one */
    BadPackage,
    /* the update package is for another kind of Flipper */
    WrongTarget,
    /* the Flipper didn't come back after an update */
    UpdateStuck,
    /* the Console has the Flipper's command line */
    ConsoleOpen,
    BlePair,
    /* that needs the USB cable (the Console) */
    UsbOnly,
    Failed,
}

impl ErrorCode {
    /* A command_status from the Flipper. */
    pub fn from_status(status: i32) -> ErrorCode {
        use CommandStatus as S;
        match CommandStatus::try_from(status) {
            Ok(S::ErrorStorageNotExist) => ErrorCode::NotFound,
            Ok(S::ErrorStorageExist) => ErrorCode::Exists,
            Ok(S::ErrorStorageDirNotEmpty) => ErrorCode::NotEmpty,
            Ok(S::ErrorStorageInvalidName) => ErrorCode::InvalidName,
            Ok(S::ErrorStorageNotReady) => ErrorCode::NoSd,
            Ok(S::ErrorAppSystemLocked) => ErrorCode::Locked,
            Ok(S::ErrorBusy) | Ok(S::ErrorStorageAlreadyOpen) => ErrorCode::Busy,
            _ => ErrorCode::Failed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceError {
    pub code: ErrorCode,
    pub detail: String,
}

impl DeviceError {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> Self {
        DeviceError {
            code,
            detail: detail.into(),
        }
    }
}

impl From<ErrorCode> for DeviceError {
    fn from(code: ErrorCode) -> Self {
        DeviceError {
            code,
            detail: String::new(),
        }
    }
}

impl std::fmt::Display for DeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.code)?;
        if !self.detail.is_empty() {
            write!(f, ": {}", self.detail)?;
        }
        Ok(())
    }
}

impl std::error::Error for DeviceError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_become_plain_codes() {
        assert_eq!(
            ErrorCode::from_status(CommandStatus::ErrorStorageNotExist as i32),
            ErrorCode::NotFound
        );
        assert_eq!(
            ErrorCode::from_status(CommandStatus::ErrorAppSystemLocked as i32),
            ErrorCode::Locked
        );
        assert_eq!(
            ErrorCode::from_status(CommandStatus::ErrorStorageDirNotEmpty as i32),
            ErrorCode::NotEmpty
        );
        assert_eq!(
            ErrorCode::from_status(CommandStatus::Error as i32),
            ErrorCode::Failed
        );
        assert_eq!(ErrorCode::from_status(9999), ErrorCode::Failed);
    }

    #[test]
    fn codes_serialize_like_the_ui_expects() {
        assert_eq!(
            serde_json::to_string(&ErrorCode::PortBusy).unwrap(),
            "\"port-busy\""
        );
        assert_eq!(
            serde_json::to_string(&ErrorCode::NoSd).unwrap(),
            "\"no-sd\""
        );
    }
}
