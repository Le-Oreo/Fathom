use serde::Serialize;
use std::time::Duration;

use crate::rpc::proto::{pb, pb_storage, pb_system};
use crate::rpc::{Content, RpcError, Session, REQUEST_TIMEOUT};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceInfo {
    pub name: String,
    pub model: String,
    pub hardware: String,
    pub region: String,
    pub firmware: String,
    pub branch: String,
    pub target: String,
    pub link: &'static str,
    pub port: String,
    pub id: String,
    pub fork: String,
    pub origin: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PowerInfo {
    pub battery: u8,
    pub charging: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StorageInfo {
    pub used: u64,
    pub total: u64,
}

pub type Pairs = Vec<(String, String)>;

fn pairs(parts: Vec<pb::Main>) -> Pairs {
    parts
        .into_iter()
        .filter_map(|m| match m.content {
            Some(Content::SystemDeviceInfoResponse(r)) => Some((r.key, r.value)),
            Some(Content::SystemPowerInfoResponse(r)) => Some((r.key, r.value)),
            _ => None,
        })
        .map(|(k, v)| (k.replace('.', "_"), v.trim().to_string()))
        .collect()
}

fn get<'a>(pairs: &'a Pairs, key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

fn region_name(code: &str) -> &str {
    match code {
        "0" => "Dev",
        "1" => "EU/RU",
        "2" => "US/CA/AU",
        "3" => "JP",
        "4" => "World",
        other => other,
    }
}

pub fn map_info(pairs: &Pairs, port: &str) -> DeviceInfo {
    let hw_target = get(pairs, "hardware_target").unwrap_or("7");
    let fw_target = get(pairs, "firmware_target").unwrap_or(hw_target);
    DeviceInfo {
        name: get(pairs, "hardware_name").unwrap_or("Flipper").to_string(),
        model: get(pairs, "hardware_model")
            .unwrap_or("Flipper Zero")
            .to_string(),
        hardware: format!("F{hw_target}"),
        region: get(pairs, "hardware_region_provisioned")
            .or_else(|| get(pairs, "hardware_region").map(region_name))
            .unwrap_or("")
            .to_string(),
        firmware: get(pairs, "firmware_version").unwrap_or("").to_string(),
        branch: get(pairs, "firmware_branch").unwrap_or("").to_string(),
        target: format!("f{fw_target}"),
        link: "USB-C",
        id: get(pairs, "hardware_uid").unwrap_or("").to_string(),
        port: port.to_string(),
        fork: get(pairs, "firmware_origin_fork").unwrap_or("").to_string(),
        origin: get(pairs, "firmware_origin_git").unwrap_or("").to_string(),
    }
}

pub fn map_power(pairs: &Pairs) -> PowerInfo {
    let battery = get(pairs, "charge_level")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    PowerInfo {
        battery: battery.clamp(0.0, 100.0).round() as u8,
        /* "charged": full and still on the cable */
        charging: matches!(get(pairs, "charge_state"), Some("charging" | "charged")),
    }
}

pub async fn device_info(session: &Session, port: &str) -> Result<(DeviceInfo, Pairs), RpcError> {
    let parts = session
        .request(
            Content::SystemDeviceInfoRequest(pb_system::DeviceInfoRequest {}),
            "",
            REQUEST_TIMEOUT,
        )
        .await?;
    let pairs = pairs(parts);
    let info = map_info(&pairs, port);
    session.log_in(
        "system_device_info_response",
        &format!("{}, {}", info.name, info.firmware),
    );
    Ok((info, pairs))
}

pub async fn power_info(session: &Session) -> Result<PowerInfo, RpcError> {
    Ok(map_power(&power_pairs(session).await?))
}

pub async fn power_pairs(session: &Session) -> Result<Pairs, RpcError> {
    let parts = session
        .request(
            Content::SystemPowerInfoRequest(pb_system::PowerInfoRequest {}),
            "",
            REQUEST_TIMEOUT,
        )
        .await?;
    Ok(pairs(parts))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Serialize)]
pub struct Clock {
    pub year: u32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    /* 1 Monday .. 7 Sunday */
    pub weekday: u32,
}

pub async fn get_clock(session: &Session) -> Result<Clock, RpcError> {
    let parts = session
        .request(
            Content::SystemGetDatetimeRequest(pb_system::GetDateTimeRequest {}),
            "",
            REQUEST_TIMEOUT,
        )
        .await?;
    let d = parts
        .into_iter()
        .find_map(|m| match m.content {
            Some(Content::SystemGetDatetimeResponse(r)) => r.datetime,
            _ => None,
        })
        .ok_or_else(|| RpcError::Protocol("no datetime".into()))?;
    Ok(Clock {
        year: d.year,
        month: d.month,
        day: d.day,
        hour: d.hour,
        minute: d.minute,
        second: d.second,
        weekday: d.weekday,
    })
}

pub async fn set_clock(session: &Session, c: Clock) -> Result<(), RpcError> {
    let valid = (2000..=2099).contains(&c.year)
        && (1..=12).contains(&c.month)
        && (1..=31).contains(&c.day)
        && c.hour < 24
        && c.minute < 60
        && c.second < 60
        && (1..=7).contains(&c.weekday);
    if !valid {
        return Err(RpcError::Protocol("not a date the Flipper takes".into()));
    }
    let detail = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        c.year, c.month, c.day, c.hour, c.minute, c.second
    );
    session
        .request(
            Content::SystemSetDatetimeRequest(pb_system::SetDateTimeRequest {
                datetime: Some(pb_system::DateTime {
                    hour: c.hour,
                    minute: c.minute,
                    second: c.second,
                    day: c.day,
                    month: c.month,
                    year: c.year,
                    weekday: c.weekday,
                }),
            }),
            &detail,
            REQUEST_TIMEOUT,
        )
        .await?;
    Ok(())
}

/* None when the SD card is missing (or not ready). */
pub async fn storage_info(session: &Session, root: &str) -> Result<Option<StorageInfo>, RpcError> {
    let _turn = session.storage_turn().await;
    let req = Content::StorageInfoRequest(pb_storage::InfoRequest { path: root.into() });
    /* counting free space on a big card can take the Flipper a while */
    let parts = match session.request(req, root, Duration::from_secs(30)).await {
        Err(RpcError::Status(s)) if root == "/ext" && no_card(s) => return Ok(None),
        r => r?,
    };
    let info = parts.into_iter().find_map(|m| match m.content {
        Some(Content::StorageInfoResponse(r)) => Some(r),
        _ => None,
    });
    Ok(match info {
        Some(r) if r.total_space > 0 => Some(StorageInfo {
            used: r.total_space.saturating_sub(r.free_space),
            total: r.total_space,
        }),
        _ if root == "/ext" => None,
        _ => Some(StorageInfo { used: 0, total: 0 }),
    })
}

fn no_card(status: i32) -> bool {
    status == pb::CommandStatus::ErrorStorageNotReady as i32
        || status == pb::CommandStatus::ErrorStorageNotExist as i32
}
