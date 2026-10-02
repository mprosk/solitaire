/**
 * Shared account UI: email OTP (+ magic link), username prompt, menu Log In / Log Out.
 *
 * iPhone home-screen apps use separate storage from Chrome/Safari. Opening a magic
 * link logs you into the browser, not the bookmark — so we emphasize entering the
 * 6-digit email code inside this app.
 */
import {
  fetchMyProfile,
  onAuthStateChange,
  signInWithMagicLink,
  signOut,
  updateScreenName,
  verifyEmailOtp,
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

/**
 * Control, zero-width, bidi, and other invisible characters.
 * Mirrors profiles_screen_name_chars_check in the database.
 */
const SCREEN_NAME_FORBIDDEN =
  /[\p{Cc}\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/u;

/** Same normalization the database trigger applies. */
function normalizeScreenName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function isStandaloneDisplay() {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  } catch {
    return false;
  }
}

function loginDialogHtml() {
  return `
<dialog id="gg-login-dialog" class="gg-login-dialog">
  <div class="dialog-heading">
    <h2 data-gg-login-title>Log in</h2>
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
      <p id="gg-login-email-hint" class="gg-field-hint">We’ll email a 6-digit code. No password needed.</p>
    </div>
    <p class="gg-form-error" data-gg-login-error hidden></p>
    <div class="gg-form-actions">
      <button type="submit" class="primary-button gg-primary">Email me a code</button>
    </div>
  </form>
  <div class="gg-login-sent" data-gg-login-sent hidden>
    <p class="gg-form-status" data-gg-login-status>
      Check your email for a 6-digit code.
    </p>
    <p class="gg-field-hint" data-gg-login-standalone-hint hidden>
      You’re in the home screen app — enter the code here. Opening the email link
      signs you into the browser instead, and you won’t stay logged in here.
    </p>
    <form id="gg-otp-form" class="gg-otp-form" novalidate>
      <div class="gg-field">
        <label for="gg-otp-token">6-digit code</label>
        <input
          id="gg-otp-token"
          name="token"
          type="tel"
          inputmode="numeric"
          pattern="[0-9]*"
          autocomplete="one-time-code"
          enterkeyhint="done"
          maxlength="6"
          required
          placeholder="••••••"
          aria-describedby="gg-otp-hint"
        />
        <p id="gg-otp-hint" class="gg-field-hint">Verifies automatically when all 6 digits are in. Desktop can still use the email link.</p>
      </div>
      <p class="gg-form-error" data-gg-otp-error hidden></p>
      <div class="gg-form-actions">
        <button type="button" class="gg-secondary" data-gg-close-login>Cancel</button>
      </div>
    </form>
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
  const loginTitle = loginDialog.querySelector("[data-gg-login-title]");
  const loginError = loginDialog.querySelector("[data-gg-login-error]");
  const loginSent = loginDialog.querySelector("[data-gg-login-sent]");
  const loginStatus = loginDialog.querySelector("[data-gg-login-status]");
  const standaloneHint = loginDialog.querySelector("[data-gg-login-standalone-hint]");
  const otpForm = loginDialog.querySelector("#gg-otp-form");
  const otpError = loginDialog.querySelector("[data-gg-otp-error]");
  const otpInput = loginDialog.querySelector("#gg-otp-token");
  const usernameForm = usernameDialog.querySelector("#gg-username-form");
  const usernameError = usernameDialog.querySelector("[data-gg-username-error]");

  let current = { user: null, profile: null };
  let promptingUsername = false;
  /** @type {string | undefined} */
  let loginRedirectTo;
  /** @type {string} */
  let pendingEmail = "";
  let otpVerifying = false;

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
    pendingEmail = "";
    otpForm?.reset();
    setError(loginError, "");
    setError(otpError, "");
  }

  function showLoginSent(email) {
    pendingEmail = email;
    loginForm.hidden = true;
    loginSent.hidden = false;
    loginStatus.textContent = email
      ? `We sent a code to ${email}. Enter it below to finish logging in.`
      : "Check your email for a 6-digit code, then enter it below.";
    if (standaloneHint) standaloneHint.hidden = !isStandaloneDisplay();
    setError(otpError, "");
    otpForm?.reset();
    window.setTimeout(() => otpInput?.focus(), 50);
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

  let refreshChain = Promise.resolve();

  /** Serialized so overlapping auth events don't race each other's paint. */
  function refreshProfile(opts = {}) {
    refreshChain = refreshChain.then(
      () => loadProfile(opts),
      () => loadProfile(opts),
    );
    return refreshChain;
  }

  async function loadProfile({ promptIfMissing = false } = {}) {
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

  function openLoginDialog(title = "Log in") {
    loginTitle.textContent = title;
    loginForm.reset();
    showLoginForm();
    openDialog(loginDialog);
  }

  loginButton.addEventListener("click", () => {
    loginRedirectTo = undefined;
    openLoginDialog();
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
      const { error } = await signInWithMagicLink(email, {
        ...(loginRedirectTo ? { emailRedirectTo: loginRedirectTo } : {}),
      });
      if (error) {
        setError(loginError, error.message || "Could not send sign-in email.");
        return;
      }
      showLoginSent(email);
    } catch (err) {
      setError(loginError, err?.message || "Could not send sign-in email.");
    } finally {
      submitBtn.disabled = false;
    }
  });

  otpForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void tryVerifyOtp();
  });

  async function tryVerifyOtp() {
    if (otpVerifying || !otpInput) return;
    setError(otpError, "");
    const email = pendingEmail || String(loginForm.querySelector("#gg-login-email")?.value || "").trim();
    const token = String(otpInput.value || "").replace(/\D/g, "").slice(0, 6);
    otpInput.value = token;

    if (!isValidEmail(email)) {
      setError(otpError, "Go back and enter your email again.");
      return;
    }
    if (token.length !== 6) return;

    otpVerifying = true;
    otpInput.readOnly = true;
    try {
      const { data, error } = await verifyEmailOtp(email, token);
      if (error) {
        setError(otpError, error.message || "That code didn’t work. Try again.");
        otpInput.value = "";
        otpInput.readOnly = false;
        otpInput.focus();
        return;
      }
      if (!data?.session) {
        setError(otpError, "Could not start a session. Try a new code.");
        otpInput.value = "";
        otpInput.readOnly = false;
        otpInput.focus();
        return;
      }
      // SIGNED_IN fires next and loads the profile / username prompt.
      closeDialog(loginDialog);
    } catch (err) {
      setError(otpError, err?.message || "Could not verify that code.");
      otpInput.readOnly = false;
    } finally {
      otpVerifying = false;
    }
  }

  loginForm.querySelector("#gg-login-email")?.addEventListener("input", () => {
    setError(loginError, "");
  });
  otpInput?.addEventListener("input", () => {
    setError(otpError, "");
    const digits = String(otpInput.value || "").replace(/\D/g, "").slice(0, 6);
    if (otpInput.value !== digits) otpInput.value = digits;
    if (digits.length === 6) void tryVerifyOtp();
  });

  usernameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(usernameError, "");
    const name = normalizeScreenName(new FormData(usernameForm).get("screen_name"));
    const length = [...name].length;
    if (length < 2 || length > 24) {
      setError(usernameError, "Username must be 2–24 characters.");
      return;
    }
    if (SCREEN_NAME_FORBIDDEN.test(name)) {
      setError(usernameError, "Username has an invisible or control character. Retype it.");
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

  // Supabase runs this callback while holding its auth lock, so calling back into
  // the client here can deadlock. Defer the real work to a fresh task.
  // INITIAL_SESSION fires for every new subscriber, which covers the first load.
  onAuthStateChange((event) => {
    window.setTimeout(() => {
      if (event === "SIGNED_OUT") {
        current = { user: null, profile: null };
        promptingUsername = false;
        closeDialog(usernameDialog);
        paint();
        return;
      }
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "USER_UPDATED") {
        void refreshProfile({ promptIfMissing: true });
      }
    }, 0);
  });

  return {
    getState: () => current,
    /**
     * @param {{ emailRedirectTo?: string, title?: string }} [opts]
     */
    openLogin: (opts = {}) => {
      loginRedirectTo = opts.emailRedirectTo;
      openLoginDialog(opts.title);
    },
    refreshProfile,
  };
}
