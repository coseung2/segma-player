# Aura Media Downloader Privacy Policy

**Effective date:** `[OWNER INPUT: EFFECTIVE_DATE]`  
**Publisher:** `[OWNER INPUT: LEGAL_PUBLISHER_NAME]`  
**Contact:** `[OWNER INPUT: SUPPORT_EMAIL]`  
**Policy URL:** `[OWNER INPUT: PRIVACY_POLICY_HTTPS_URL]`

Aura Media Downloader is a Chrome extension for detecting compatible media resources and saving media that the user is authorized to download. This policy describes the store distribution and its separately installed local companion.

## Information processed

The extension temporarily processes the current page URL and title, compatible media URLs and types, the page referrer and language preference, candidate metadata, and download-job status to perform media detection and a user-requested download. Authentication, cookie, and API-key headers are discarded rather than retained or replayed. The selected local folder handle and session state are stored locally. A user-entered URL is processed only to perform that requested download.

The extension does not request an Aura account, collect passwords, cookies for an Aura service, payment data, precise location, health data, or advertising identifiers. It does not sell personal information or use browsing activity for advertising.

## Where data goes

Media requests are made to the original site or media host selected by the user. The extension does not upload media or browsing data to an Aura server. When the user starts a supported operation, the extension may use the separately installed `com.aura.media_companion` through Chrome native messaging. That helper runs on the user’s device and writes output to a local folder. The extension package contains no private native-host bridge, fixed extension key, or remote code.

## Retention and deletion

Candidate data, request metadata, and download-job state are kept only in extension session/local storage needed for the feature. The user may clear the selected download folder in Settings or uninstall the extension. Files already saved by the user remain under the user’s control and are not deleted by uninstall.

## Third-party sites and authorization

The extension does not change the terms of a third-party site. Users must comply with the site’s terms, copyright law, and any applicable license. The extension does not bypass DRM, login restrictions, paywalls, private-video controls, or other access controls.

## Security and changes

The publisher applies reasonable safeguards for the local extension/companion boundary. No online service can be guaranteed secure. Material policy changes will be published at the policy URL with a new effective date.

## Contact

Privacy questions and deletion requests: `[OWNER INPUT: SUPPORT_EMAIL]`.
