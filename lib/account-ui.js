/**
 * Shared account UI: magic-link login, username prompt, menu Log In / Log Out.
 */
import {
  fetchMyProfile,
  onAuthStateChange,
  signInWithMagicLink,
  signOut,
  updateScreenName,
} from "./supabase.js";

function ensureDialog(id, html, { replace = false } = {}) {
  let dialog = document.getElementById(id);
  if (dialog && replace) {
    dialog.remove();
    dialog = null;
  }
  if (dialog) return dialog;
  const wrap = document.createElement("div");
  wrap.innerHTML = html.trim();
  dialog = wrap.firstElementChild;
  document.body.appendChild(dialog);
  return dialog;
}

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function isValidEmail(email) {
  const value = String(email || "").trim();
  if (!value || value.length > 254) return false;
  // Practical format check: local@domain.tld (no spaces).
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function loginDialogHtml() {
  return `
<dialog id="gg-login-dialog" class="gg-login-dialog">
  <div class="dialog-heading">
    <h2>Log in</h2>
    <button type="button" class="icon-button dark" data-gg-close-login aria-label="Close">×</button>
  </div>
  <form id="gg-login-form" class="gg-login-form" novalidate>
    <div class="gg-field">
      <label for="gg-login-email">Email</label>
      <input
        id="gg-login-email"
        name="email"
        type="email"
        inputmode="email"
        autocomplete="email"
        enterkeyhint="send"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        required
        placeholder="you@example.com"
        aria-describedby="gg-login-email-hint"
      />
      <p id="gg-login-email-hint" class="gg-field-hint">We’ll email you a sign-in link. No password needed.</p>
    </div>
    <p class="gg-form-error" data-gg-login-error hidden></p>
    <div class="gg-form-actions">
      <button type="submit" class="primary-button gg-primary">Email me a sign-in link</button>
    </div>
  </form>
  <div class="gg-login-sent" data-gg-login-sent hidden>
    <p class="gg-form-status" data-gg-login-status>
      Check your email for a sign-in link. Open it on this device to finish logging in.
    </p>
    <p class="gg-field-hint">You can close this and keep browsing while you wait.</p>
    <div class="gg-form-actions">
      <button type="button" class="primary-button gg-primary" data-gg-close-login>Done</button>
    </div>
  </div>
</dialog>`;
}

function usernameDialogHtml() {
  return `
<dialog id="gg-username-dialog" class="gg-username-dialog">
  <div class="dialog-heading">
    <h2>Choose a username</h2>
  </div>
  <p class="gg-field-hint">2–24 characters. This is how you’ll appear on the leaderboard.</p>
  <form id="gg-username-form">
    <div class="gg-field">
      <label for="gg-username-input">Username</label>
      <input id="gg-username-input" name="screen_name" type="text" minlength="2" maxlength="24" required autocomplete="nickname" />
    </div>
    <p class="gg-form-error" data-gg-username-error hidden></p>
    <div class="gg-form-actions">
      <button type="submit" class="primary-button gg-primary">Save</button>
    </div>
  </form>
</dialog>`;
}

/**
 * @param {{
 *   loginButton: HTMLElement,
 *   logoutButton: HTMLElement,
 *   screenNameEl?: HTMLElement | null,
 *   onAuthChange?: (state: { user: object | null, profile: object | null }) => void,
 * }} options
 */
export function mountAccountUi(options) {
  const { loginButton, logoutButton, screenNameEl = null, onAuthChange } = options;

  const loginDialog = ensureDialog("gg-login-dialog", loginDialogHtml(), { replace: true });
  const usernameDialog = ensureDialog("gg-username-dialog", usernameDialogHtml());
  const loginForm = loginDialog.querySelector("#gg-login-form");
  loginForm.noValidate = true;
  const loginError = loginDialog.querySelector("[data-gg-login-error]");
  const loginSent = loginDialog.querySelector("[data-gg-login-sent]");
  const loginStatus = loginDialog.querySelector("[data-gg-login-status]");
  const usernameForm = usernameDialog.querySelector("#gg-username-form");
  const usernameError = usernameDialog.querySelector("[data-gg-username-error]");

  let current = { user: null, profile: null };
  let promptingUsername = false;

  function setError(el, message) {
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = message;
  }

  function showLoginForm() {
    loginForm.hidden = false;
    loginSent.hidden = true;
    setError(loginError, "");
  }

  function showLoginSent(email) {
    loginForm.hidden = true;
    loginSent.hidden = false;
    loginStatus.textContent = email
      ? `Check ${email} for a sign-in link. Open it on this device to finish logging in.`
      : "Check your email for a sign-in link. Open it on this device to finish logging in.";
  }

  function paint() {
    const signedIn = Boolean(current.user);
    loginButton.hidden = signedIn;
    logoutButton.hidden = !signedIn;
    if (screenNameEl) {
      if (signedIn && current.profile?.screen_name) {
        screenNameEl.hidden = false;
        screenNameEl.textContent = current.profile.screen_name;
      } else {
        screenNameEl.hidden = true;
        screenNameEl.textContent = "";
      }
    }
    onAuthChange?.(current);
  }

  async function refreshProfile({ promptIfMissing = false } = {}) {
    const { data: profile, error, user } = await fetchMyProfile();
    current = { user, profile: error ? null : profile };
    paint();
    if (promptIfMissing && user && !profile?.screen_name && !promptingUsername) {
      promptingUsername = true;
      usernameForm.reset();
      setError(usernameError, "");
      openDialog(usernameDialog);
    }
    return current;
  }

  loginButton.addEventListener("click", () => {
    loginForm.reset();
    showLoginForm();
    openDialog(loginDialog);
  });

  logoutButton.addEventListener("click", async () => {
    await signOut();
    current = { user: null, profile: null };
    paint();
  });

  loginDialog.querySelectorAll("[data-gg-close-login]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(loginDialog));
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(loginError, "");
    const emailInput = loginForm.querySelector("#gg-login-email");
    const email = String(new FormData(loginForm).get("email") || "").trim();
    if (emailInput) emailInput.value = email;

    if (!isValidEmail(email)) {
      setError(loginError, "Enter a valid email address (like you@example.com).");
      emailInput?.focus();
      return;
    }

    const submitBtn = loginForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const { error } = await signInWithMagicLink(email);
      if (error) {
        setError(loginError, error.message || "Could not send sign-in link.");
        return;
      }
      showLoginSent(email);
    } catch (err) {
      setError(loginError, err?.message || "Could not send sign-in link.");
    } finally {
      submitBtn.disabled = false;
    }
  });

  loginForm.querySelector("#gg-login-email")?.addEventListener("input", () => {
    setError(loginError, "");
  });

  usernameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(usernameError, "");
    const name = String(new FormData(usernameForm).get("screen_name") || "").trim();
    if (name.length < 2 || name.length > 24) {
      setError(usernameError, "Username must be 2–24 characters.");
      return;
    }
    const submitBtn = usernameForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const { data, error } = await updateScreenName(name);
      if (error) {
        const taken = error.code === "23505" || /duplicate|unique/i.test(error.message || "");
        setError(usernameError, taken ? "That name is taken." : error.message || "Could not save.");
        return;
      }
      current = { ...current, profile: data };
      promptingUsername = false;
      paint();
      closeDialog(usernameDialog);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Prevent dismissing username dialog without a name (new accounts).
  usernameDialog.addEventListener("cancel", (event) => {
    if (!current.profile?.screen_name) event.preventDefault();
  });

  onAuthStateChange(async (event) => {
    if (event === "SIGNED_OUT") {
      current = { user: null, profile: null };
      promptingUsername = false;
      closeDialog(usernameDialog);
      paint();
      return;
    }
    if (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") {
      await refreshProfile({ promptIfMissing: event === "SIGNED_IN" || event === "INITIAL_SESSION" });
    }
  });

  refreshProfile({ promptIfMissing: true });

  return {
    getState: () => current,
    openLogin: () => loginButton.click(),
    refreshProfile,
  };
}
