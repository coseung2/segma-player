use super::dto::CommandError;
use crate::license as domain;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseDto {
    pub pro: bool,
    pub masked_key: Option<String>,
    pub expires_at: Option<u64>,
    pub days_remaining: Option<u64>,
    pub devices: Option<u32>,
    pub limit: Option<u32>,
}

fn to_dto(license: domain::AppLicense) -> LicenseDto {
    LicenseDto {
        pro: license.pro,
        masked_key: (!license.key.is_empty()).then(|| license.masked_key()),
        expires_at: license.expires_at,
        days_remaining: license.days_remaining(),
        devices: license.devices,
        limit: license.limit,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyLicenseRequest {
    pub key: String,
}

fn license_error(error: domain::LicenseError) -> CommandError {
    let code = error.code();
    let message = match error {
        domain::LicenseError::DeviceLimit {
            devices: Some(devices),
            limit: Some(limit),
        } => {
            format!("등록 가능한 기기 수를 초과했습니다. ({devices}/{limit})")
        }
        other => other.message().to_string(),
    };
    CommandError::new(code, message)
}

#[tauri::command]
pub async fn get_license() -> Result<LicenseDto, CommandError> {
    tauri::async_runtime::spawn_blocking(|| Ok(to_dto(domain::load())))
        .await
        .map_err(|_| CommandError::new("operation-failed", "라이선스를 불러오지 못했습니다."))?
}

#[tauri::command]
pub async fn verify_license(request: VerifyLicenseRequest) -> Result<LicenseDto, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let license = domain::verify(&request.key).map_err(license_error)?;
        domain::save_approved(&license)
            .map_err(|_| license_error(domain::LicenseError::SaveFailed))?;
        Ok(to_dto(license))
    })
    .await
    .map_err(|_| {
        CommandError::new(
            "license-verification-failed",
            "인증 작업을 완료하지 못했습니다.",
        )
    })?
}

#[tauri::command]
pub async fn remove_license() -> Result<LicenseDto, CommandError> {
    tauri::async_runtime::spawn_blocking(|| {
        domain::remove().map_err(|_| license_error(domain::LicenseError::SaveFailed))?;
        Ok(to_dto(domain::load()))
    })
    .await
    .map_err(|_| CommandError::new("operation-failed", "라이선스를 삭제하지 못했습니다."))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn license_dto_never_contains_the_raw_key() {
        let license = domain::AppLicense {
            key: "AM-0123456789ABCDEF0123456789ABCDEF0123".into(),
            pro: true,
            ..Default::default()
        };
        let dto = to_dto(license);
        assert_eq!(dto.masked_key.as_deref(), Some("AM-••••••••0123"));
    }
}
