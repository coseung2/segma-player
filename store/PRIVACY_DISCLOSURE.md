# Chrome Web Store privacy disclosure worksheet

Use this worksheet when completing the Chrome Web Store privacy fields. Replace every owner placeholder before submission.

## Single purpose

Detect compatible media resources and save media the user is authorized to download locally.

## Data handling answers

- **Personally identifiable information:** Not collected by Aura Media Downloader.
- **Health, financial, or location data:** Not collected.
- **Authentication information:** When the user activates a Pro license, the entered license key and a randomly generated device identifier (UUID) are stored locally and sent to the Aura license server only to validate the key and enforce the per-key device limit. Passwords, PINs, and security questions are not collected.
- **Browsing activity:** The extension reads the active page URL/title and compatible media request metadata only to perform the stated media-detection function. It does not sell or use browsing activity for advertising.
- **Website content:** Media URLs, response types, page titles, the page referrer, and language preference may be processed temporarily to identify and fetch a user-requested resource. Authentication, cookie, and API-key headers are discarded rather than retained or replayed. With the optional Windows Companion, user-requested download commands and bounded job metadata are passed to the local Native Messaging host; browser-authenticated progressive/HLS bytes stay on the user's PC. During migration, a user-entered YouTube URL and job metadata may be sent to the existing Aura YouTube service only when the local Companion path is unavailable.
- **User settings:** Session download and candidate state are stored locally for the extension's function. The optional Companion stores local job-state files so active downloads can survive browser restarts. No sync database is used.
- **Sale or transfer:** Data is not sold or transferred to third parties for advertising or credit decisions.
- **Remote code:** The extension does not download or execute remote extension code.

## Retention and deletion

Session candidates and request metadata remain extension-local and bounded. Companion job-state files are retained locally under the user's Aura Media Companion application-data directory until removed with the Companion or cleaned by a future maintenance action. The user controls downloaded files and can remove the selected folder in extension settings. Uninstalling the extension removes extension-managed local state; files already saved to the user’s Downloads folder are not automatically deleted.

## Required owner fields

- Privacy policy HTTPS URL: `[OWNER INPUT: PRIVACY_POLICY_HTTPS_URL]`
- Support email: `[OWNER INPUT: SUPPORT_EMAIL]`
- Product website: `[OWNER INPUT: PRODUCT_WEBSITE_URL]`
