//! Asynchronous license workflow for the settings surface.

use std::sync::mpsc::{self, Receiver, Sender};

use crate::license::{self, AppLicense, LicenseError};

pub(crate) enum LicenseNotice {
    Info(String),
    Error(String),
}

pub(crate) struct LicenseController {
    pub(crate) current: AppLicense,
    pub(crate) key_input: String,
    pub(crate) checking: bool,
    pub(crate) focus_requested: bool,
    checking_existing: bool,
    result_sender: Sender<Result<AppLicense, LicenseError>>,
    result_receiver: Receiver<Result<AppLicense, LicenseError>>,
}

impl Default for LicenseController {
    fn default() -> Self {
        let (result_sender, result_receiver) = mpsc::channel();
        let current = license::load();
        let key_input = if current.pro {
            String::new()
        } else {
            current.key.clone()
        };
        Self {
            current,
            key_input,
            checking: false,
            focus_requested: false,
            checking_existing: false,
            result_sender,
            result_receiver,
        }
    }
}

impl LicenseController {
    pub(crate) fn verify(&mut self, raw_key: String) -> Option<LicenseNotice> {
        if self.checking {
            return None;
        }
        let Some(key) = license::normalize_key(&raw_key) else {
            return Some(LicenseNotice::Error("인증키 형식을 확인해 주세요.".into()));
        };
        self.checking_existing = self.current.pro && self.current.key == key;
        self.checking = true;
        let sender = self.result_sender.clone();
        std::thread::spawn(move || {
            let _ = sender.send(license::verify(&key));
        });
        None
    }

    pub(crate) fn poll(&mut self) -> Vec<LicenseNotice> {
        let mut notices = Vec::new();
        while let Ok(result) = self.result_receiver.try_recv() {
            self.checking = false;
            let checking_existing = std::mem::take(&mut self.checking_existing);
            match result {
                Ok(approved) => match license::save_approved(&approved) {
                    Ok(()) => {
                        self.current = approved;
                        self.key_input.clear();
                        notices.push(LicenseNotice::Info(
                            "Segma Player Pro 인증이 완료됐습니다.".into(),
                        ));
                    }
                    Err(_) => {
                        notices.push(LicenseNotice::Error(LicenseError::SaveFailed.message()))
                    }
                },
                Err(error) => {
                    if checking_existing && error.invalidates_existing_pro() {
                        let _ = license::remove();
                        self.current = AppLicense::default();
                        self.key_input.clear();
                    }
                    notices.push(LicenseNotice::Error(error.message()));
                }
            }
        }
        notices
    }

    pub(crate) fn remove(&mut self) -> LicenseNotice {
        match license::remove() {
            Ok(()) => {
                self.current = AppLicense::default();
                self.key_input.clear();
                LicenseNotice::Info("일반 플랜으로 전환했습니다.".into())
            }
            Err(error) => LicenseNotice::Error(format!("인증 정보를 지우지 못했습니다: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_keys_fail_before_starting_a_worker() {
        let mut controller = LicenseController::default();
        let notice = controller.verify("bad-key".into());
        assert!(matches!(notice, Some(LicenseNotice::Error(_))));
        assert!(!controller.checking);
    }
}
