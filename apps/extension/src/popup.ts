import './styles.css';

const pageLabel = document.querySelector<HTMLParagraphElement>('#page-label');
const originValue = document.querySelector<HTMLElement>('#origin-value');
const helperValue = document.querySelector<HTMLElement>('#helper-value');
const statusBadge = document.querySelector<HTMLElement>('#status-badge');
const mirrorButton = document.querySelector<HTMLButtonElement>('#mirror-button');

function setText(element: Element | null, value: string): void {
  if (element) {
    element.textContent = value;
  }
}

async function initialize(): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab?.id || !activeTab.url) {
    setText(pageLabel, 'No active web page is available.');
    setText(statusBadge, 'Unavailable');
    return;
  }

  const url = new URL(activeTab.url);
  const isSupportedProtocol = url.protocol === 'http:' || url.protocol === 'https:';

  setText(pageLabel, activeTab.title ?? url.href);
  setText(originValue, url.origin);
  setText(helperValue, 'Pending POC');
  setText(statusBadge, isSupportedProtocol ? 'Ready' : 'Unsupported');

  if (mirrorButton) {
    mirrorButton.disabled = !isSupportedProtocol;
    mirrorButton.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        type: 'webmirror.capture.requested',
        tabId: activeTab.id,
      });
      window.close();
    });
  }
}

void initialize();
