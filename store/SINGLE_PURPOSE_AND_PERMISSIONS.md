# Single-purpose and permission justifications

## Single purpose

The extension has one user-facing purpose: detect compatible media resources in the current browsing context and save media the user is authorized to download. The popup, content detector, background worker, download queue, and local companion are all limited to that purpose. The extension does not provide advertising, unrelated site modifications, account management, social features, or general-purpose browsing controls.

## Permission review

| Permission | Exact use in the shipped runtime |
| --- | --- |
| `activeTab` | Gives the popup and user action access to the active page needed for a rescan or dynamic detector injection. |
| `contextMenus` | Adds the user-invoked “Aura Media로 다운로드” action for video and audio elements. |
| `declarativeNetRequest` | Creates and removes short-lived, exact media-fetch session rules so requests can carry the page referrer and language preference. Authentication, cookie, and API-key headers are not retained or replayed. The store manifest has no static site-specific rule resource. |
| `nativeMessaging` | Connects to the separately installed `com.aura.media_companion` local helper for local file writing. |
| `offscreen` | Runs the hidden download worker needed to consume media streams and write them without opening a visible tab. |
| `scripting` | Injects the isolated detector after a user action or extension reload when a content script is not already present. |
| `storage` | Stores session-scoped candidate and download-job state. No sync storage or remote account database is used. |
| `webRequest` | Observes HTTP(S) media responses and retains only the page referrer and language preference needed to identify compatible media and perform a user-requested fetch. Authentication, cookie, and API-key headers are discarded. It does not modify page content. |

## Host access

HTTP and HTTPS host access is required because the detector is intentionally useful on the current page across arbitrary sites, and the background service worker registers its request observers before optional host permissions can be granted. The extension filters and redacts candidate data before showing it in the popup. Host access does not grant permission to download content the user is not authorized to use.

## Native companion boundary

The Chrome Web Store ZIP contains only extension runtime files. The native companion installer is hosted separately, must be code-signed, and registers `com.aura.media_companion` for the published extension origin after the store ID is known. The installer must not be bundled into the store ZIP.
