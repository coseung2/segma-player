# Personal VPN media detector

## Canonical extension folder

Use this folder as the only development and Chrome/Edge load location:

`C:\Users\coseung2\Desktop\Projects\aura-mdownloader`

`C:\Users\malla\Desktop\PersonalVPN-Browser-Extension` is an old copy. Do
not load or edit that folder; remove it from `chrome://extensions` or
`edge://extensions` if it is currently installed, then load the canonical
folder above.

This is a Manifest V3 personal-use extension. It declares HTTP/HTTPS host
access because its global `webRequest` listener cannot be registered with
optional permissions that have not yet been granted. It observes likely
progressive, HLS, DASH, and blob resource URLs,
keeps at most 500 LRU candidates in service-worker memory. The desktop/native
UI receives redacted text-only projections; the browser popup receives an
in-memory preview URL only for rendering the thumbnail, never as visible text
or persisted data.

Candidate messages sent to the desktop app use a local native-messaging bridge
envelope defined in `bridge.js`. The extension supplies only its fixed identity
and an ephemeral session id. Each native-host process generates a fresh host
challenge, and the request-bound acknowledgement installs that challenge for
the session. Later messages bind the host challenge, monotonic sequence, and
fresh nonces. Secrets and full resource URLs are never persisted or logged.

The desktop app registers the native-host manifest only after the user clicks
“Register native host”. Registration is current-user-only for Chrome and Edge;
it never writes HKLM and never enables or installs the extension. To sideload
for personal use:

1. Open `chrome://extensions` (or `edge://extensions`) and enable Developer mode.
2. Choose “Load unpacked” and select the canonical folder above.
3. Confirm the extension ID is `hfpkpbadllkhedocoglbggkpnbaibmcp`.
4. Keep `aura-vpn` beside this repository, run its Windows setup, then reload
   the extension.
5. Confirm the loaded extension version is `0.2.41`. If an older version is
   shown, remove it and load the canonical folder again.

After an update, open tabs keep running the previous page detector until they
are refreshed; the extension re-injects the current detector automatically on
install, so a refresh is only needed for a clean single instance.
6. The page-level detector runs automatically. Click the extension action to
   open the candidate popover; candidates are also sent through the
   authenticated local bridge.

The extension contains no VPN private key, enrollment code, cookies, or
authorization headers. The shared bridge context is only a fixed channel
binding; session challenges, expiry, sequence numbers, and replay protection
remain enforced by both peers.

Windows downloads use a second restricted native host,
`com.personalvpn.media_route`. Before the extension fetches a player page,
playlist, key, initialization segment, media segment, or direct video, it asks
the local route broker to place that destination hostname on the physical
non-VPN gateway. Successful leases are cached only until the broker's expiry;
missing, partial, expired, rejected, or timed-out route responses stop the
download instead of falling back through the VPN. Only normalized hostnames and
lease expiry times are persisted—URL paths, query tokens, cookies, and request
headers are not written to the route queue or route state.

For the Windows browser workflow, right-click a video or audio element and
choose “Aura VPN으로 미디어 다운로드”. Direct MP4 and WebM resources use the
selected folder. HLS master/media playlists can be downloaded
and are merged in a hidden offscreen extension document; fMP4 segments are saved as MP4
and MPEG-TS segments as TS. AES-128 and AES-256 encrypted HLS streams are
decrypted locally during download (keys are fetched with the same cookies and
Referer as the segments). Segments are streamed straight to disk as they
arrive — six segments are fetched concurrently, decrypted, and written in
order — so the growing file can already be opened in a player such as VLC
while the download is still running. The downloader also replays the request
headers the site itself used for playlists, keys, and segments (captured by
the background service worker), so tokenized or header-checking CDNs get the
same Referer, Origin, and custom headers as the page.

Clicking the extension action opens a small candidate popover. It shows the
detected page media and provides a download button for progressive MP4/WebM
resources; use “현재 페이지 다시 감지” when a page started playback after the
popover was opened.

When a page has many related or recommended embeds, the popover's “메인 영상만
보기” toggle (on by default) keeps only the main player's media. The main
player is recognized as the largest visible video element or video-embed
iframe on the page; candidates from it carry a “메인 영상” badge. If no main
player is recognized, every candidate is shown.

Several main candidates usually mean the stream's master playlist plus its
quality variants (480p/720p/1080p…); each download picks the highest quality
automatically. Candidate titles use the page or tab title.

The popover shows candidates for the current tab only. “현재 페이지 다시 감지”
clears that tab's previously detected media first, so stale entries from an
earlier video or another page do not linger.

HLS and progressive downloads stream through the installed native helper to
`Downloads\Aura Media`. The popover has no folder picker, so Chrome's protected
folder warning is not part of the workflow.

Detection matches the response `Content-Type` as well as the URL path, so
tokenized playlist addresses that do not end in `.m3u8` are still found — this
also works on pages that lock DevTools, because nothing needs F12 or the
page's own debugger. The popover additionally has a “직접 주소로 다운로드” box:
paste any m3u8 or MP4/WebM URL there and it downloads through the same HLS or
direct-save path without touching the page's developer tools.

Direct MP4 hosts that serve extensionless URLs (for example DoodStream's
`doodcdn.io/getfile/...` links with an `application/octet-stream` Content-Type)
are detected as progressive media because the browser reports them as
`media` network requests and video-element sources are media by definition.
The pasted-URL box also sniffs the response Content-Type, so extensionless
direct file links work there too.

Pasting a player page URL also works now: the extension follows DoodStream-style
player pages (`/d/...` or `/e/...`), calls the `/pass_md5` endpoint the player
uses, and downloads the direct file URL it returns — all without DevTools.
On such player pages, the content script also resolves `/pass_md5` on page
load, so the candidate appears without first pressing play. Opening the
popover no longer clears the detected list; only the explicit “현재 페이지
다시 감지” button does, and navigating to a new page clears that tab's stale
candidates.

Direct media URLs are refreshed from the player page right before saving, so
expired token links do not fail immediately. The download page then consumes
the readable response itself and writes it directly to disk.

Downloads run without opening a new browser tab. Their queued, running,
completed, and failed states are shown in the popover's “다운로드” tab.

DoodStream direct downloads now ask the player iframe itself to re-resolve
`/pass_md5` at the moment saving starts, so the stream URL is fresh and the
CDN sees the exact Referer the player frame uses. This avoids expired-token
and Referer-check failures from the background fetch.

Before each playlist, key, segment, or direct-media request, the extension
registers a session-scoped rule matching that exact tokenized URL. It supplies
the recorded Referer and request headers, removes the extension Origin, and
deletes the rule after the response body is consumed. Stale rules are also
cleaned automatically.

All direct MP4/WebM downloads stream through the extension fetch so those
headers apply on every host. The browser's native download manager is not used
for downloads started from the popover or context menu, because it cannot
carry the Referer or Origin headers that header-checking CDNs require.

DoodStream-family pages still re-resolve `/pass_md5` in the player frame before
the exact-URL request rule is installed. If the readable extension request is
rejected, the existing page-download fallback remains available.

The hidden worker writes each download directly through the native
`Downloads\Aura Media` writer.

Players that hide the stream behind a blob: video source (hls.js-style) no
longer mark that blob as the main media. The real HLS playlist stays visible
and downloadable in the popover, including with the main-only filter on.

Every chunk is consumed and written inside the download page; binary data no
longer crosses Chrome runtime messages. Writes still normalize bytes and use
an explicit `{ type: "write", data }` parameter.

The popover's “YouTube” tab sends public single-video URLs to the restricted
`com.aura.youtube_downloader` native host. Run `install-youtube-host.ps1` with
the portable video-downloader ZIP to install its yt-dlp, Node, and
FFmpeg tools under `%LOCALAPPDATA%\AuraDownloader\youtube`. The host is a
Windows GUI-subsystem executable and starts yt-dlp with `CREATE_NO_WINDOW`, so
no console window is created. YouTube output is written to the Windows
Downloads folder. Login-only, private, paid, playlist, and DRM bypasses are not
implemented.

The YouTube tab offers automatic best quality or maximum 2160p, 1440p,
1080p, 720p, and 480p caps. The native host prefixes the output filename with
the actual downloaded video height, for example `[1080p] Title [id].mp4`.

## 광고 차단 (Aura VPN 브라우저 확장)

팝업의 “차단” 탭과 설정 페이지에서 개인용 광고 차단을 켜고 끕니다.

- **요청 차단**: `declarativeNetRequest` 동적 규칙으로 광고·추적기 도메인의
  스크립트/iframe/픽셀 요청을 차단합니다. 규칙은 `adblock/adblock-rules.js`의
  `AD_HOSTS`(광고), `TRACKER_HOSTS`(추적기) 목록에서 생성됩니다.
- **빈 광고 영역 제거**: `adblock/adblock-content.js`가 광고 컨테이너/배너
  선택자를 `display:none`으로 숨기고, 나중에 추가되는 요소는 MutationObserver로
  따라잡습니다.
- **팝업·오버레이 차단**: 강함 필터를 켜면 고정(fixed/sticky) 위치의
  팝업·모달·쿠키 배너류 요소를 숨깁니다. 일반 모달을 덮지 않도록 위치 기반으로만
  판단합니다.
- **사이트별 허용**: popup 차단 탭에서 현재 사이트를 허용 목록에 넣거나 뺄 수
  있고, 설정 페이지에서 전체 허용 목록을 관리합니다. 허용한 사이트에는
  요청 차단(DNR 규칙의 `excludedInitiatorDomains`)과 요소 숨김이 모두 적용되지
  않습니다.
- **차단 통계**: 오늘 날짜 기준 차단 요청·숨긴 광고 영역·차단한 팝업/오버레이
  수를 popup에 표시합니다. 통계는 `chrome.storage.local`의 `auraAdBlock`에
  저장되고 날짜가 바뀌면 초기화됩니다.
- **필터 선택**: 설정 페이지에서 광고/추적기/팝업·오버레이를 개별로 켜고 끌 수
  있습니다. 기본값은 광고+추적기 켜짐, 팝업·오버레이 꺼짐입니다.

필터는 확장 프로그램에 내장된 개인용 목록이며 원격 업데이트나 라이선스 서버를
사용하지 않습니다. 도메인이나 선택자를 추가하려면 `adblock/adblock-rules.js`와
`adblock/adblock-rules.global.js`를 수정하면 됩니다.
