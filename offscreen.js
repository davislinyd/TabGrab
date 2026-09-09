"use strict";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "tabgrab-copy") {
    return false;
  }

  if (typeof message.text !== "string" || !message.text) {
    sendResponse({ ok: false, error: "No text to copy." });
    return false;
  }

  copyText(message.text)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));

  return true;
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (clipboardError) {
    if (!copyWithExecCommand(text)) {
      throw clipboardError;
    }
  }
}

function copyWithExecCommand(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  return copied;
}
