// content.js v7.4
// Script de contenido minimalista.
// Por ahora solo responde a pings del background para verificación.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getPageInfo') {
        sendResponse({
            url: window.location.href,
            title: document.title,
            timestamp: new Date().toISOString()
        });
        return true;
    }
});

// Marker para debugging
window.__qaTestTrackerInjected = true;
