# Aura Media Downloader Privacy Policy

> [!WARNING]
> Migration draft: this policy describes the extension-primary data flow and
> optional Companion. Re-audit actual Companion storage, updates, diagnostics,
> licensing, browser handoff, and deletion behavior before the next publication.

**Effective date:** `[OWNER INPUT: EFFECTIVE_DATE]`  
**Publisher:** `[OWNER INPUT: LEGAL_PUBLISHER_NAME]`  
**Contact:** `[OWNER INPUT: SUPPORT_EMAIL]`  
**Policy URL:** `[OWNER INPUT: PRIVACY_POLICY_HTTPS_URL]`

Aura Media Downloader is a Chrome extension for detecting compatible media resources and saving media that the user is authorized to download. This policy describes the store distribution.

## Information processed

The extension temporarily processes the current page URL and title, compatible media URLs and types, the page referrer and language preference, candidate metadata, and download-job status to perform media detection and a user-requested download. Authentication, cookie, and API-key headers are discarded rather than retained or replayed. The selected local folder handle and session state are stored locally. A user-entered URL is processed only to perform that requested download. When the optional Windows Aura Media Companion is installed, the extension sends only user-requested download commands and bounded job metadata to the local `com.aura.media_companion` Native Messaging host.

When a Pro license is activated, the entered license key and a randomly generated device identifier (UUID) are stored locally and sent to the Aura license server only to validate the key and enforce the per-key device limit. The extension does not request an Aura account, collect passwords, cookies for an Aura service, payment data, precise location, health data, or advertising identifiers. It does not sell personal information or use browsing activity for advertising.

## Where data goes

Media requests are made to the original site or media host selected by the user. For Companion-handled work, media tools run locally on the user's Windows PC and save to `Downloads\\Aura Media`; browser-authenticated progressive/HLS bytes are fetched by the extension and passed locally to the Companion writer. During the YouTube migration, the existing Aura server remains a fallback when the Companion is unavailable, so a user-entered YouTube URL and the resulting job metadata may be sent to that service solely to complete the requested download. The browser File System Access and default-download paths remain fallbacks for compatible media. The extension package contains no fixed extension key or bundled native executable, and it does not load executable code remotely.

## Retention and deletion

Candidate data, request metadata, and download-job state are kept only in extension session/local storage needed for the feature. The optional Companion additionally keeps local job-state files under the user's Aura Media Companion application-data directory so an active local job can survive a browser restart. The user may clear the selected download folder in Settings, uninstall the extension, or uninstall the Companion. Files already saved by the user remain under the user’s control and are not deleted by uninstall.

## Third-party sites and authorization

The extension does not change the terms of a third-party site. Users must comply with the site’s terms, copyright law, and any applicable license. The extension does not bypass DRM, login restrictions, paywalls, private-video controls, or other access controls.

## Security and changes

The publisher applies reasonable safeguards for the extension's local storage handling. No online service can be guaranteed secure. Material policy changes will be published at the policy URL with a new effective date.

## Contact

Privacy questions and deletion requests: `[OWNER INPUT: SUPPORT_EMAIL]`.
