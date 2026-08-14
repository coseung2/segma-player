# Chrome Web Store privacy disclosure worksheet

Use this worksheet when completing the Chrome Web Store privacy fields. Replace every owner placeholder before submission.

## Single purpose

Detect compatible media resources and save media the user is authorized to download locally.

## Data handling answers

- **Personally identifiable information:** Not collected by Aura Media Downloader.
- **Health, financial, or location data:** Not collected.
- **Authentication information:** When the user activates a Pro license, the entered license key and a randomly generated device identifier (UUID) are stored locally and sent to the Aura license server only to validate the key and enforce the per-key device limit. Passwords, PINs, and security questions are not collected.
- **Browsing activity:** The extension reads the active page URL/title and compatible media request metadata only to perform the stated media-detection function. It does not sell or use browsing activity for advertising.
- **Website content:** Media URLs, response types, page titles, the page referrer, and language preference may be processed temporarily to identify and fetch a user-requested resource. Authentication, cookie, and API-key headers are discarded rather than retained or replayed. Full media is written locally or passed to the original media host; it is not uploaded to an Aura server.
- **User settings:** Session download and candidate state are stored locally for the extension's function. No sync database is used.
- **Sale or transfer:** Data is not sold or transferred to third parties for advertising or credit decisions.
- **Remote code:** The extension does not download or execute remote extension code.

## Retention and deletion

Session candidates, request metadata, and download-job state are temporary and are discarded as the browser or extension session ends. The user controls downloaded files and can remove the selected folder in extension settings. Uninstalling the extension removes extension-managed local state; files already saved to the user’s Downloads folder are not automatically deleted.

## Required owner fields

- Privacy policy HTTPS URL: `[OWNER INPUT: PRIVACY_POLICY_HTTPS_URL]`
- Support email: `[OWNER INPUT: SUPPORT_EMAIL]`
- Product website: `[OWNER INPUT: PRODUCT_WEBSITE_URL]`
