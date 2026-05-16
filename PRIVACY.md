# Privacy Policy for TabVault Pro

**Last Updated:** May 16, 2026

TabVault Pro ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use the TabVault Pro browser extension.

## 1. Information We Collect
TabVault Pro is designed with a **Local-First** architecture. We do not operate backend database servers, and we do not collect, transmit, or sell your personal data.
- **Browser History & Tabs:** The extension accesses your tabs, titles, and URLs solely to provide tab management, suspension, and workspace features. 
- **Local Storage:** All your workspaces, sessions, rules, and visual thumbnails are stored entirely locally on your device's hard drive using your browser's IndexedDB.

## 2. Artificial Intelligence (AI) Features
- **Built-in AI (`window.ai`):** Tab summarization features utilize your browser's local, built-in AI model (Gemini Nano). No tab data is sent to external cloud servers for this feature.
- **Semantic Search (Bring Your Own Key):** If you choose to enter your own Google Gemini API key in the settings, your search queries and open tab titles/URLs are sent directly from your browser to Google's API (`generativelanguage.googleapis.com`) to process the search. We do not intercept, route, or store this transmission. Please refer to [Google's Privacy Policy](https://policies.google.com/privacy) for how they handle API requests.

## 3. Permissions Justification
TabVault Pro requests the minimum permissions necessary to function:
- `tabs` & `tabGroups`: Required to read, organize, close duplicates, and suspend your open tabs.
- `storage`: Required to save your settings and workspaces locally.
- `alarms`: Required for the Tab Snoozing feature to wake up tabs on a schedule in the background.
- `sidePanel`: Required to display the extension's user interface.
- `<all_urls>` / `captureVisibleTab`: Required to generate silent, highly compressed visual thumbnail previews of the tabs you visit for the Grid View feature (images are stored locally).

## 4. Changes to This Policy
We may update this Privacy Policy to reflect changes in our practices or browser extension requirements. We will notify you of any changes by updating the "Last Updated" date at the top of this policy.

## 5. Contact Us
If you have any questions, concerns, or requests regarding this Privacy Policy or your data, please contact us via our GitHub repository issues page or the Chrome Web Store support tab.
