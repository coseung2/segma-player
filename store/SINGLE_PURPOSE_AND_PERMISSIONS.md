# Single-purpose and permission justifications

## Single purpose

The extension has one user-facing purpose: detect compatible media resources in the current browsing context and save media the user is authorized to download. The popup, content detector, background worker, and download queue are all limited to that purpose. The extension does not provide advertising, unrelated site modifications, account management, social features, or general-purpose browsing controls.

## Permission review

| Permission | Exact use in the shipped runtime |
| --- | --- |
| `activeTab` | Gives the popup and user action access to the active page needed for a rescan or dynamic detector injection. |
| `alarms` | Registers a short periodic heartbeat only while a download is active, so the MV3 service worker and the offscreen download worker stay alive long enough to finish saving. The alarm is cleared as soon as no download work remains. |
| `contextMenus` | Adds the user-invoked “Aura Media로 다운로드” action for video and audio elements. |
| `declarativeNetRequest` | Creates and removes short-lived, exact media-fetch session rules so requests can carry the page referrer and language preference. Authentication, cookie, and API-key headers are not retained or replayed. The store manifest has no static site-specific rule resource. |
| `downloads` | Uses the browser download manager as a fallback to save a completed media file when the offscreen worker path cannot write directly, and to monitor its completion. |
| `offscreen` | Runs the hidden download worker needed to consume media streams and write them without opening a visible tab. |
| `scripting` | Injects the isolated detector after a user action or extension reload when a content script is not already present. |
| `storage` | Stores session-scoped candidate and download-job state. No sync storage or remote account database is used. |
| `webRequest` | Observes HTTP(S) media responses and retains only the page referrer and language preference needed to identify compatible media and perform a user-requested fetch. Authentication, cookie, and API-key headers are discarded. It does not modify page content. |

## Host access

HTTP and HTTPS host access is required because the detector is intentionally useful on the current page across arbitrary sites, and the background service worker registers its request observers before optional host permissions can be granted. The extension filters and redacts candidate data before showing it in the popup. Host access does not grant permission to download content the user is not authorized to use.

## Extension-only saving

The Chrome Web Store ZIP contains only extension runtime files. Saving is performed by the extension's offscreen download worker and the browser download fallback; no native companion is required or bundled.
