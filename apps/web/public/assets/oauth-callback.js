// Consent POST finishes with a document, then starts an ordinary navigation.
// This avoids applying form-action to a client's later desktop-app redirect.
// The server supplies and escapes an exactly registered URL after issuing code.
const callback = document.getElementById("bickr-oauth-callback");
if (callback instanceof HTMLAnchorElement) window.location.replace(callback.href);
