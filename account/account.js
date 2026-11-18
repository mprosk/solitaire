/**
 * Account page: username, email toggles, log in/out, and the landing spot for the
 * unsubscribe link in every player email (?unsubscribe=<token>&email=<kind>).
 */
import {
  mountAccountUi,
  normalizeScreenName,
  screenNameError,
  screenNameSaveError,
} from "../lib/account-ui.js";
import {
  fetchEmailPreferences,
  setEmailSubscriptionByToken,
  updateEmailPreferences,
  updateScreenName,
} from "../lib/supabase.js";

const EMAIL_LABELS = {
  weekly_summary: "weekly summaries",
  missed_you: "“we’ve missed you” emails",
  lost_lead: "leaderboard alerts",
  all: "all GuyGames emails",
};

const $ = (selector) => document.querySelector(selector);

const signedOut = $("[data-signed-out]");
const signedIn = $("[data-signed-in]");
const nameForm = $("#account-name-form");
const nameInput = $("#account-name");
const nameError = $("[data-name-error]");
const nameSaved = $("[data-name-saved]");
const emailEl = $("[data-account-email]");
const emailError = $("[data-email-error]");
const emailSaved = $("[data-email-saved]");
const toggles = [...document.querySelectorAll(".account-toggle input")];

function show(el, message) {
  if (message === undefined) {
    el.hidden = false;
    return;
  }
  el.hidden = !message;
  el.textContent = message || "";
}

function flash(el) {
  el.hidden = false;
  window.clearTimeout(el._timer);
  el._timer = window.setTimeout(() => {
    el.hidden = true;
  }, 1800);
}

// ---------------------------------------------------------------------------
// Signed-in settings
// ---------------------------------------------------------------------------

let currentUserId = null;

async function loadEmailPreferences() {
  toggles.forEach((input) => {
    input.disabled = true;
  });
  const { data, error } = await fetchEmailPreferences();
  if (error || !data) {
    show(emailError, "Couldn’t load your email settings. Reload to try again.");
    return;
  }
  show(emailError, "");
  for (const input of toggles) {
    input.checked = Boolean(data[input.name]);
    input.disabled = false;
  }
}

for (const input of toggles) {
  input.addEventListener("change", async () => {
    const wanted = input.checked;
    input.disabled = true;
    show(emailError, "");
    const { error } = await updateEmailPreferences({ [input.name]: wanted });
    input.disabled = false;
    if (error) {
      input.checked = !wanted;
      show(emailError, "Couldn’t save that. Try again.");
      return;
    }
    flash(emailSaved);
  });
}

const account = mountAccountUi({
  loginButton: $("#account-login"),
  logoutButton: $("#account-logout"),
  onAuthChange: ({ user, profile }) => {
    signedOut.hidden = Boolean(user);
    signedIn.hidden = !user;
    if (!user) {
      currentUserId = null;
      return;
    }
    emailEl.textContent = user.email || "your account email";
    if (document.activeElement !== nameInput) nameInput.value = profile?.screen_name || "";
    if (currentUserId !== user.id) {
      currentUserId = user.id;
      void loadEmailPreferences();
    }
  },
});

nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  show(nameError, "");
  const name = normalizeScreenName(nameInput.value);
  const invalid = screenNameError(name);
  if (invalid) {
    show(nameError, invalid);
    return;
  }
  const button = nameForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const { error } = await updateScreenName(name);
    if (error) {
      show(nameError, screenNameSaveError(error));
      return;
    }
    nameInput.value = name;
    flash(nameSaved);
    void account.refreshProfile();
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Unsubscribe link from an email
// ---------------------------------------------------------------------------

async function handleUnsubscribeLink() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("unsubscribe");
  if (!token) return;
  const requested = params.get("email") ?? "";
  const kind = Object.hasOwn(EMAIL_LABELS, requested) ? requested : "all";

  const card = $("[data-unsubscribe]");
  const message = $("[data-unsubscribe-message]");
  const undo = $("[data-unsubscribe-undo]");
  card.hidden = false;

  async function apply(subscribed) {
    undo.hidden = true;
    message.textContent = "Updating your email settings…";
    const { error } = await setEmailSubscriptionByToken(token, kind, subscribed);
    if (error) {
      message.textContent =
        "That link didn’t work. Log in below to change your email settings instead.";
      return;
    }
    message.textContent = subscribed
      ? `You’re subscribed to ${EMAIL_LABELS[kind]} again.`
      : `You’re unsubscribed from ${EMAIL_LABELS[kind]}.`;
    undo.textContent = subscribed ? "Unsubscribe" : "Undo";
    undo.onclick = () => void apply(!subscribed);
    undo.hidden = false;
    if (currentUserId) void loadEmailPreferences();
  }

  await apply(false);
}

void handleUnsubscribeLink();
