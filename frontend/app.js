import { request, initData, needsMax, withTimeout, loadSession, logoutSession, element, statusMessage, profileAvatar, button, submitButton, field, formHandler, panelLink, maxBotLink, showSiteVersion } from "./ui.js";
import { appendReportDetails, reportCard, decisionStats, reviewPageUrl, REPORT_ID } from "./report-view.js";

const $ = (id) => document.getElementById(id);
const accountDialog = $("account-dialog");
const accountForm = $("account-form");
const accountMessage = $("account-message");
const accountSubmit = $("account-submit");
const maxLogin = $("max-login");
const browserNotice = $("browser-max-notice");
const panel = $("panel-dialog");
const panelContent = $("tab-content");
const profileTabIcon = $("open-profile").firstElementChild;
const defaultProfileIcon = profileTabIcon.firstElementChild;
const tabTitles = { home: "Главная", history: "Мои обращения", achievements: "Мои достижения", profile: "Мой аккаунт" };
let currentTab = "home";
let tabAnimation;
let loginRequest = null;
let session = null;
let afterLogin = null;
let panelVersion = 0;
let bridge;
let editDraft;
let syncDrafts;

export function registerOfflineDraftSync(sync) {
    syncDrafts = sync;
    if (session?.user && navigator.onLine) void sync(session.user.max_id);
}

browserNotice.append(maxBotLink());
maxLogin.append(maxBotLink());

export function registerDraftEditor(editor) {
    editDraft = editor;
}

function showSessionError(content, error, retry) {
    content.replaceChildren(statusMessage(error.message), button("Повторить", retry));
    if (error.status === 403) {
        const message = statusMessage();
        content.append(button("Выйти из аккаунта", async () => {
            try {
                setSession(await logoutSession());
                if (panel.open) panel.close();
                retry();
            } catch (logoutError) {
                message.textContent = logoutError.message;
            }
        }), message);
    }
}

function setSession(data) {
    const previousUser = session?.user;
    const user = data.user;
    session = data;
    if (user && navigator.onLine && syncDrafts) void syncDrafts(user.max_id);
    if (previousUser?.max_id !== user?.max_id || previousUser?.first_name !== user?.first_name
        || previousUser?.last_name !== user?.last_name || previousUser?.photo_url !== user?.photo_url) {
        profileTabIcon.replaceChildren(user ? profileAvatar(user, "П") : defaultProfileIcon);
    }
    browserNotice.hidden = !needsMax(data);
    if (data.camera_login_error) {
        browserNotice.querySelector("p").textContent = data.camera_login_error;
        browserNotice.hidden = false;
    }
    if (data.mode === "max" && initData() && !bridge) {
        bridge = new Promise((resolve) => {
            if (window.WebApp?.PermissionsManager) {
                resolve(window.WebApp);
                return;
            }
            const script = document.createElement("script");
            script.src = "https://st.max.ru/js/max-web-app.js";
            script.onload = () => resolve(window.WebApp);
            script.onerror = () => resolve(null);
            document.head.append(script);
        });
    }
}

export function requestMaxCameraAccess() {
    return bridge ? requestBridgeCameraAccess() : null;
}

async function requestBridgeCameraAccess() {
    const app = await withTimeout(bridge, 4000, "MaxBridgeUnavailable");
    const manager = app?.PermissionsManager;
    if (typeof manager?.init !== "function" || typeof manager.requestAccess !== "function") {
        throw new DOMException("", "MaxBridgeUnavailable");
    }
    return withTimeout(checkMaxCameraPermission(manager), 30000, "MaxPermissionTimeout");
}

function maxPermissionCode(error) {
    const code = error?.error?.code ?? error?.code;
    return typeof code === "string" ? code : error?.name;
}

function maxPermissionFailure(error, bridgeStep) {
    const code = maxPermissionCode(error);
    let name = "MaxPermissionError";
    if (typeof code === "string") {
        if (code.endsWith("app_permission_denied")) name = "MaxAppPermissionDenied";
        if (code.endsWith("system_permission_denied")) name = "MaxSystemPermissionDenied";
    }
    return Object.assign(new DOMException("", name), { bridgeCode: code, bridgeStep });
}

async function checkMaxCameraPermission(manager) {
    for (const retry of [false, true]) {
        try {
            await manager.init();
        } catch (error) {
            throw maxPermissionFailure(error, "init");
        }

        let info;
        try {
            info = await manager.requestAccess(["camera"], "Для съёмки знака и автомобиля");
        } catch (error) {
            const code = maxPermissionCode(error);
            if (!retry && ["client.permissions_request_access.not_inited", "client.permissions_request_access.not_found"].includes(code)) continue;
            throw maxPermissionFailure(error, "request");
        }

        const camera = info?.camera;
        if (camera?.appAccessGranted === false && camera.appAccessRequested !== false) {
            throw maxPermissionFailure({ code: "app_permission_denied" }, "request");
        }
        if (camera?.systemAccessGranted === false) {
            throw maxPermissionFailure({ code: "system_permission_denied" }, "request");
        }
        return;
    }
}

export function maxCameraSettings(code) {
    const manager = window.WebApp?.PermissionsManager;
    if (code === "MaxAppPermissionDenied") return manager?.openMaxSettings?.bind(manager);
    if (code === "MaxSystemPermissionDenied") return manager?.openSystemSettings?.bind(manager);
}

function openLogin(action) {
    const test = session.mode === "test";
    const outsideMax = needsMax(session);
    maxLogin.hidden = !outsideMax;
    accountSubmit.textContent = test ? "Войти в тестовом режиме" : "Войти через MAX";
    accountSubmit.hidden = accountSubmit.disabled = outsideMax;
    accountMessage.textContent = "";
    afterLogin = action;
    if (currentTab === "home" || $("report-dialog").open) {
        accountDialog.append(accountForm);
        if (!accountDialog.open) accountDialog.showModal();
    } else {
        panelContent.replaceChildren(element("h3", "Вход"), accountForm);
    }
}

export async function requireAccount(action, { allowOffline = false } = {}) {
    if (allowOffline && !navigator.onLine && session?.user) {
        action(session.user);
        return;
    }
    const version = panelVersion;
    try {
        if (loginRequest) await loginRequest;
        const data = await loadSession();
        if (version !== panelVersion) return;
        setSession(data);
    } catch (error) {
        if (version !== panelVersion) return;
        if (allowOffline && error.connectionFailed && session?.user) {
            action(session.user);
            return;
        }
        const content = currentTab === "home" || $("report-dialog").open ? openModalPanel("Вход") : panelContent;
        showSessionError(content, error, () => {
            if (panel.open) panel.close();
            requireAccount(action);
        });
        return;
    }
    if (!session.user) {
        openLogin(action);
        return;
    }
    action(session.user);
}

accountForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loginRequest || !session || needsMax(session)) return;
    const action = afterLogin;
    const version = panelVersion;
    const input = session.mode === "test" ? {} : { init_data: initData() };
    accountSubmit.disabled = true;
    accountMessage.textContent = "Входим…";
    try {
        loginRequest = request("/api/session", input);
        const data = await loginRequest;
        if (version !== panelVersion || action !== afterLogin) return;
        setSession(data);
        accountForm.reset();
        if (accountDialog.open) accountDialog.close();
        afterLogin = null;
        action?.(session.user);
    } catch (error) {
        if (version === panelVersion && action === afterLogin) accountMessage.textContent = error.message;
    } finally {
        loginRequest = null;
        accountSubmit.disabled = needsMax(session);
    }
});
accountDialog.addEventListener("close", () => {
    if (!accountDialog.open) afterLogin = null;
});

function openModalPanel(title) {
    $("panel-title").textContent = title;
    const content = $("panel-content");
    content.replaceChildren();
    if (!panel.open) panel.showModal();
    return content;
}

function openPanel(title) {
    panelVersion += 1;
    if (panelContent.contains(accountForm)) accountDialog.append(accountForm);
    $("tab-title").textContent = title;
    panelContent.replaceChildren();
    window.scrollTo(0, 0);
    return panelVersion;
}

function activePanel(version) {
    return currentTab !== "home" && panelVersion === version;
}

function showProfile() {
    const version = openPanel("Мой аккаунт");
    const user = session?.user;
    const identity = element("div", "", "profile-card");
    const text = element("div");
    const name = user ? `${user.first_name} ${user.last_name}`.trim() || "Пользователь MAX" : "Гость";
    text.append(element("strong", name), element("p", user
        ? (session.mode === "test" ? "Тестовый аккаунт" : `ID MAX: ${user.max_id}`)
        : "Войдите, чтобы отправлять обращения"));
    identity.append(profileAvatar(user), text);
    panelContent.append(identity);
    const menu = element("div", "", "profile-menu");
    if (user && session.mode === "test") menu.append(button("Личные данные", showEditProfile));
    menu.append(
        button("Мои достижения", () => navigate("achievements")),
        button("Черновики", () => navigate("history", null, "drafts")),
        button("Правила использования", () => showRules()),
        button("О проекте", showAbout),
    );
    panelContent.append(menu);

    if (!user) {
        const login = button("Войти в аккаунт", () => requireAccount(showProfile), true);
        login.id = "profile-login";
        panelContent.append(login);
    }
    if (session?.review_enabled) {
        const label = user?.reviewer ? "Кабинет проверяющего" : "Вход для проверяющего";
        panelContent.append(panelLink(label, reviewPageUrl(), Boolean(user?.reviewer)));
    }
    if (!user) return;
    const stats = element("section", "", "panel-stack capture-section");
    const statsMessage = statusMessage("Загружаем статистику…");
    stats.append(element("h3", "Мои обращения"), statsMessage);
    identity.after(stats);
    request("/api/reports/stats").then((data) => {
        if (activePanel(version)) statsMessage.replaceWith(decisionStats(data));
    }).catch((error) => {
        if (activePanel(version)) statsMessage.textContent = error.message;
    });
    const logoutMessage = statusMessage();
    const logout = button("Выйти из аккаунта", async () => {
        logout.disabled = true;
        try {
            setSession(await logoutSession());
            if (activePanel(version)) showProfile();
        } catch (error) {
            logoutMessage.textContent = error.message;
        } finally {
            logout.disabled = false;
        }
    });
    panelContent.append(logout, logoutMessage);
}

function showEditProfile() {
    const version = openPanel("Личные данные");
    const user = session.user;
    const profile = element("form", "", "panel-stack");
    const profileMessage = statusMessage();
    profile.append(
        field("Имя", "first_name", { value: user.first_name, maxLength: 80, required: true }),
        field("Фамилия", "last_name", { value: user.last_name, maxLength: 80, required: true }),
        submitButton("Сохранить профиль"),
        profileMessage,
    );
    formHandler(profile, profileMessage, "/api/profile", (data) => {
        setSession(data);
        if (activePanel(version)) showProfile();
    });
    panelContent.append(button("Назад", showProfile), profile);
}

const achievementDefinitions = [
        ["first_report", "⭐", "Первый шаг", "За первое обращение", "Впервые успешно отправьте обращение через приложение."],
        ["two_photos", "📸", "Чёткий кадр", "За две фотографии", "Приложите к одному обращению общий снимок автомобиля на парковочном месте и отдельный снимок с госномером."],
        ["offline_sync", "☁️", "Всегда на связи", "За синхронизацию офлайн", "Создайте обращение или черновик без интернета. Достижение откроется после синхронизации с сервером."],
        ["gps_capture", "📍", "Внимательный наблюдатель", "За точные координаты", "Отправьте обращение с определёнными GPS-координатами и временем фиксации."],
        ["rules_read", "📖", "Знаю правила", "За изучение правил", "Откройте правила использования и нажмите «Я ознакомился»."],
        ["three_accepted", "🤝", "Надёжный помощник", "За три принятых обращения", "Дождитесь, когда проверяющий примет три ваших обращения."],
    ];

function achievementGrid(interactive = false) {
    const grid = element("div", "", "achievement-grid");
    const progress = new Map();
    for (const [code, icon, title, description, condition] of achievementDefinitions) {
        const card = element("article", "", "achievement-card");
        const badge = element("span", icon, "achievement-icon");
        badge.setAttribute("aria-hidden", "true");
        const mark = element("span", "", "achievement-mark");
        const details = element("details", "", "achievement-details");
        details.append(element("summary", "Как получить"), element("p", condition));
        if (interactive && code === "rules_read") details.append(button("Правила использования", () => showRules(card.dataset.earned === "true")));
        card.append(badge, element("strong", title), element("p", description), mark, details);
        grid.append(card);
        progress.set(code, { card, mark });
    }
    return { grid, progress };
}

function markAchievements(progress, earned) {
    for (const [code, { card, mark }] of progress) {
        const unlocked = earned.includes(code);
        card.dataset.earned = String(unlocked);
        mark.textContent = unlocked ? "Получено" : "Пока не получено";
    }
}

const publicUserCache = new Map();
function loadPublicUser(identifier) {
    const cached = publicUserCache.get(identifier);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const entry = { expires: Date.now() + 10000, promise: null };
    entry.promise = request(`/api/public/users/${identifier}`).then((user) => {
        entry.expires = Date.now() + (user.first_name && user.photo_url ? 60000 : 5000);
        return user;
    }).catch((error) => {
        if (publicUserCache.get(identifier) === entry) publicUserCache.delete(identifier);
        throw error;
    });
    publicUserCache.set(identifier, entry);
    return entry.promise;
}

function publicName(user) {
    return [user.first_name, user.last_name].filter(Boolean).join(" ") || `Пользователь MAX №${user.id}`;
}

function publicUserButton(identifier, back, label = "Автор обращения") {
    const control = button("", () => showPublicProfile(identifier, back));
    control.classList.add("public-user");
    const text = element("span", "", "public-user-text");
    text.append(element("small", label), element("strong", "Пользователь MAX"));
    control.append(profileAvatar(null, "П"), text);
    void loadPublicUser(identifier).then((user) => {
        text.querySelector("strong").textContent = publicName(user);
        control.firstElementChild.replaceWith(profileAvatar(user, "П"));
    }).catch(() => {});
    return control;
}

async function loadLeaderboard(version, message, list) {
    try {
        const { users } = await request("/api/public/leaderboard");
        if (!activePanel(version)) return;
        if (!users.length) {
            message.textContent = "В рейтинге пока нет принятых обращений.";
            return;
        }
        message.remove();
        for (const [index, user] of users.entries()) {
            const row = element("div", "", "ranking-row");
            row.append(element("strong", String(index + 1), "ranking-place"),
                publicUserButton(user.id, showAchievements, "Участник"),
                element("span", String(user.approved), "ranking-score"));
            row.lastElementChild.setAttribute("aria-label", `Принято обращений: ${user.approved}`);
            list.append(row);
        }
    } catch (error) {
        if (activePanel(version)) message.textContent = error.message;
    }
}

async function showPublicProfile(identifier, back = showAchievements) {
    const version = openPanel("Профиль участника");
    const message = statusMessage("Загружаем профиль…");
    panelContent.append(button("Назад", back), message);
    try {
        const user = await loadPublicUser(identifier);
        if (!activePanel(version)) return;
        message.remove();
        const identity = element("div", "", "profile-card");
        const text = element("div");
        text.append(element("strong", publicName(user)), element("p", `Принято обращений: ${user.approved}`));
        if (user.rank != null) text.append(element("p", `Место в рейтинге: ${user.rank}`));
        identity.append(profileAvatar(user, "П"), text);
        panelContent.append(identity);
        if (user.profile_url) {
            const link = panelLink("Открыть профиль в MAX", user.profile_url);
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            panelContent.append(link);
        }
        const { grid, progress } = achievementGrid();
        markAchievements(progress, user.earned);
        panelContent.append(element("h2", "Достижения"), grid);
        const history = element("section", "", "public-profile-history");
        const historyStatus = statusMessage("Загружаем обращения…");
        history.append(element("h2", "Публичные обращения"), historyStatus);
        panelContent.append(history);
        try {
            const { reports } = await request(`/api/public/users/${identifier}/reports`);
            if (!activePanel(version)) return;
            if (!reports.length) {
                historyStatus.textContent = "У участника пока нет публичных обращений.";
            } else {
                historyStatus.remove();
                for (const report of reports) {
                    const control = button("Подробнее об обращении", () => showDetails(report.id, "public", () => showPublicProfile(identifier, back)));
                    history.append(reportCard(report, `/api/public/reports/${report.id}`, control));
                }
            }
        } catch (error) {
            if (activePanel(version)) historyStatus.textContent = error.message;
        }
    } catch (error) {
        if (activePanel(version)) message.textContent = error.message;
    }
}

async function showAchievements() {
    const version = openPanel("Мои достижения");
    const { grid, progress } = achievementGrid(true);
    const message = statusMessage("Загружаем достижения…");
    const ranking = element("section", "", "leaderboard");
    ranking.id = "leaderboard";
    ranking.tabIndex = -1;
    ranking.append(element("h2", "Рейтинг пользователей"), element("p", "По числу принятых обращений", "ranking-subtitle"));
    const rankingList = element("div", "", "ranking-list");
    const rankingStatus = statusMessage("Загружаем рейтинг…");
    ranking.append(rankingStatus, rankingList);
    const rankingShortcut = button("", () => {
        ranking.focus({ preventScroll: true });
        ranking.scrollIntoView({ block: "start" });
    });
    rankingShortcut.classList.add("leaderboard-shortcut");
    rankingShortcut.setAttribute("aria-controls", "leaderboard");
    const shortcutText = element("span", "", "leaderboard-shortcut-text");
    shortcutText.append(element("strong", "Рейтинг пользователей"), element("small", "По принятым обращениям"));
    const arrow = element("span", "↓", "leaderboard-shortcut-arrow");
    arrow.setAttribute("aria-hidden", "true");
    rankingShortcut.append(element("span", "🏆", "leaderboard-shortcut-icon"), shortcutText, arrow);
    panelContent.append(message, rankingShortcut, grid, ranking);
    void loadLeaderboard(version, rankingStatus, rankingList);
    try {
        const data = await loadSession();
        if (!activePanel(version)) return;
        setSession(data);
        if (!data.user) {
            message.textContent = "Войдите, чтобы увидеть свои достижения.";
            message.after(button("Войти в аккаунт", () => requireAccount(showAchievements), true));
            return;
        }
        if (navigator.onLine) await syncDrafts?.(data.user.max_id);
        const { earned } = await request("/api/achievements");
        if (!activePanel(version)) return;
        message.remove();
        markAchievements(progress, earned);
    } catch (error) {
        if (activePanel(version)) message.textContent = error.message;
    }
}

function showRules(acknowledged = false, error = "") {
    const content = openModalPanel("Правила использования");
    const rules = element("ul", "", "service-rules");
    for (const text of [
        "Отправляйте обращения о возможных нарушениях на парковочных местах для людей с инвалидностью.",
        "Снимайте автомобиль, номер и парковочный знак или разметку. Используйте снимки, сделанные на месте.",
        "Проверьте геолокацию и адрес перед отправкой. Добавляйте только относящиеся к обращению сведения.",
        "Решение внутренней проверки доступно в разделе «Обращения».",
    ]) rules.append(element("li", text));
    const accept = button("Я ознакомился", () => {
        panel.close();
        requireAccount(async () => {
            try {
                await request("/api/achievements/rules", {});
                if (currentTab === "achievements") void showAchievements();
                showRules(true);
            } catch (error) {
                showRules(false, error.message);
            }
        });
    }, true);
    accept.disabled = acknowledged;
    content.append(rules, accept, statusMessage(acknowledged ? "Ознакомление сохранено." : error));
}

async function showList(filter = "sent") {
    const version = openPanel("Обращения");
    const filters = element("div", "", "report-filter");
    for (const [name, label] of [["sent", "Отправленные"], ["drafts", "Черновики"], ["public", "Публичные"]]) {
        const control = button(label, () => navigate("history", undefined, name), filter === name);
        control.setAttribute("aria-pressed", String(filter === name));
        filters.append(control);
    }
    const message = statusMessage("Загружаем обращения…");
    panelContent.append(filters, message);
    if (filter === "public") panelContent.append(element("h2", "Публичные обращения от других пользователей"));
    try {
        if (filter !== "public" && navigator.onLine && session?.user) await syncDrafts?.(session.user.max_id);
        if (!activePanel(version)) return;
        const { reports } = await request(filter === "public" ? "/api/public/reports" : "/api/reports");
        if (!activePanel(version)) return;
        const visible = filter === "public" ? reports : reports.filter((report) => {
            const draft = report.status === "draft" || (report.auto_rejected && !report.submitted_at);
            return draft === (filter === "drafts");
        });
        if (visible.length === 0) {
            message.classList.add("empty-card");
            message.textContent = filter === "public" ? "Публичных обращений пока нет." : filter === "drafts"
                ? "Черновиков пока нет" : "Пока нет обращений. После отправки здесь появится их история и статус";
            return;
        }
        message.remove();
        for (const report of visible) {
            const control = button("Подробнее об обращении", () => showDetails(report.id, filter));
            const card = reportCard(report, `${filter === "public" ? "/api/public/reports" : "/api/reports"}/${report.id}`, control);
            if (filter === "public") card.append(publicUserButton(report.author_id, () => showList("public")));
            panelContent.append(card);
        }
    } catch (error) {
        if (!activePanel(version)) return;
        message.textContent = error.message;
        if (error.status === 401) panelContent.append(button("Войти в аккаунт", () => requireAccount(() => showList(filter)), true));
        else panelContent.append(button("Повторить", () => showList(filter)));
    }
}

export function showHistory(identifier, filter) {
    navigate("history", identifier, filter);
}

function reportConfirmation(label, text, submit, path, onSuccess) {
    const confirmation = element("details", "", "report-confirmation");
    const form = element("form", "", "panel-stack");
    const feedback = statusMessage();
    form.append(element("p", text), submitButton(submit), feedback);
    formHandler(form, feedback, path, onSuccess);
    confirmation.append(element("summary", label), form);
    return confirmation;
}

async function showDetails(identifier, filter = "sent", back = null) {
    const version = openPanel(`Обращение №${identifier}`);
    const message = statusMessage("Загружаем обращение…");
    panelContent.append(button("К списку", back || (() => navigate("history", undefined, filter))), message);
    const path = `${filter === "public" ? "/api/public/reports" : "/api/reports"}/${identifier}`;
    try {
        const report = await request(path);
        if (!activePanel(version)) return;
        message.remove();
        if (filter === "public") {
            const link = new URL(location.href);
            link.searchParams.set("tab", "history");
            link.searchParams.set("filter", "public");
            link.searchParams.set("report", identifier);
            link.hash = "";
            panelContent.append(publicUserButton(report.author_id, () => showDetails(identifier, "public", back)));
            panelContent.append(panelLink("Ссылка на публичное обращение", link.href));
        } else if (report.author_id != null) {
            panelContent.append(publicUserButton(report.author_id, () => showDetails(identifier, filter), "Автор обращения"));
        }
        appendReportDetails(panelContent, report, path);
        if (filter === "public") return;
        if (report.status !== "draft" && report.status !== "withdrawn") {
            const label = element("label", "", "visibility-setting");
            const toggle = element("input");
            toggle.type = "checkbox";
            toggle.checked = report.is_public;
            const text = element("span");
            text.append(element("strong", "Публичное обращение"), element("small", "Другие пользователи увидят фотографии, адрес, номер и ваш профиль."));
            const status = statusMessage();
            toggle.addEventListener("change", async () => {
                toggle.disabled = true;
                try {
                    const data = await request(`${path}/visibility`, { is_public: toggle.checked });
                    report.is_public = data.is_public;
                    status.textContent = data.is_public ? "Обращение опубликовано" : "Обращение скрыто";
                } catch (error) {
                    toggle.checked = report.is_public;
                    status.textContent = error.message;
                } finally {
                    toggle.disabled = false;
                }
            });
            label.append(toggle, text);
            panelContent.append(label, status);
        }
        if (report.capture_id && editDraft) {
            panelContent.append(button("Продолжить черновик", () => editDraft(report), true));
        }
        if (report.status === "draft") {
            panelContent.append(reportConfirmation("Удалить черновик", "Снимки и данные черновика будут удалены.",
                "Подтвердить удаление", `${path}/delete-draft`, () => {
                    if (activePanel(version)) showHistory(undefined, "drafts");
                }));
        } else if (["pending", "under_review"].includes(report.status)) {
            panelContent.append(reportConfirmation("Отозвать обращение", "После отзыва обращение снимут с проверки. Оно останется в вашей истории.",
                "Подтвердить отзыв", `${path}/withdraw`, () => {
                    if (activePanel(version)) return showDetails(identifier, filter);
                }));
        }
    } catch (error) {
        if (!activePanel(version)) return;
        message.textContent = error.message;
        panelContent.append(button("Повторить", () => showDetails(identifier, filter)));
    }
}

function showAbout() {
    const content = openModalPanel("О проекте");
    content.append(
        element("p", "«ЧУЖОЕ МЕСТО» помогает сохранять доступность парковочных мест для людей с инвалидностью"),
        element("p", "Результат внутренней проверки описывает качество и содержание материалов"),
        button("Правила использования", () => showRules()),
    );
}

function tabFromUrl() {
    const tab = new URL(location.href).searchParams.get("tab");
    return Object.hasOwn(tabTitles, tab) ? tab : "home";
}

function renderTab(tab, identifier, filter = "sent") {
    const tabs = Object.keys(tabTitles);
    const tabIndex = tabs.indexOf(tab);
    const direction = Math.sign(tabIndex - tabs.indexOf(currentTab));
    document.querySelector(".tab-bar").style.setProperty("--indicator-offset", `${tabIndex * 100}%`);
    currentTab = tab;
    $("tab-screen").dataset.tab = tab;
    afterLogin = null;
    if (accountDialog.open) accountDialog.close();
    if (panel.open) panel.close();
    $("home-content").hidden = tab !== "home";
    $("tab-screen").hidden = tab === "home";
    for (const name of tabs) {
        const control = $("open-" + name);
        if (name === tab) control.setAttribute("aria-current", "page");
        else control.removeAttribute("aria-current");
    }
    openPanel(tabTitles[tab]);
    if (tab === "home") return;
    if (direction && window.matchMedia("(prefers-reduced-motion: no-preference)").matches) {
        tabAnimation?.cancel();
        tabAnimation = $("tab-screen").animate?.([
            { opacity: 0.3, transform: `translateX(${direction * 22}px)` },
            { opacity: 1, transform: "none" },
        ], { duration: 360, easing: "cubic-bezier(.25,.7,.25,1)" });
    }
    panelContent.append(statusMessage("Загрузка…"));
    if (tab === "achievements") {
        showAchievements();
        return;
    }
    if (tab === "profile") {
        const version = panelVersion;
        loadSession().then((data) => {
            if (!activePanel(version)) return;
            setSession(data);
            showProfile();
        }).catch((error) => {
            if (activePanel(version)) showSessionError(panelContent, error, () => renderTab("profile"));
        });
        return;
    }
    if (identifier != null) showDetails(identifier, filter);
    else showList(filter);
}

function tabUrl(tab, filter) {
    const url = new URL(location.href);
    if (tab === "home") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    if (tab === "history" && ["drafts", "public"].includes(filter)) url.searchParams.set("filter", filter);
    else url.searchParams.delete("filter");
    url.searchParams.delete("report");
    url.searchParams.delete("user");
    url.searchParams.delete("review");
    return url;
}

function navigate(tab, identifier, filter) {
    const url = tabUrl(tab, filter);
    if (url.href !== location.href) history.pushState(null, "", url);
    renderTab(tab, identifier, filter);
}

function renderLocation() {
    const tab = tabFromUrl();
    const params = new URL(location.href).searchParams;
    const review = params.get("review");
    if (tab === "profile" && (review === "queue" || REPORT_ID.test(review))) {
        location.replace(reviewPageUrl(review === "queue" ? undefined : review));
        return;
    }
    const filter = ["drafts", "public"].includes(params.get("filter")) ? params.get("filter") : "sent";
    const identifier = filter === "public" && REPORT_ID.test(params.get("report") || "") ? params.get("report") : undefined;
    renderTab(tab, identifier, filter);
    const profile = params.get("user") || "";
    if (tab === "achievements" && REPORT_ID.test(profile)) void showPublicProfile(profile);
}

for (const tab of Object.keys(tabTitles)) {
    $("open-" + tab).addEventListener("click", () => navigate(tab));
}
window.addEventListener("popstate", renderLocation);
window.addEventListener("online", () => {
    if (currentTab === "achievements") void showAchievements();
});
$("open-about").addEventListener("click", showAbout);
function animateSceneButton(control, keyframes, duration) {
    let motion;
    control.addEventListener("click", () => {
        motion?.cancel();
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        motion = control.firstElementChild.animate?.(keyframes, { duration, easing: "ease-in-out" });
    });
}

animateSceneButton($("parking-warning"), [
    { transform: "scale(1)" },
    { transform: "scale(.92)", offset: .24 },
    { transform: "scale(1.08)", offset: .6 },
    { transform: "scale(1)" },
], 360);
animateSceneButton($("parking-car"), [
    { transform: "none" },
    { transform: "scale(1.018, .966)", offset: .27 },
    { transform: "translateY(-2px) scale(.993, 1.016)", offset: .63 },
    { transform: "none" },
], 380);
loadSession().then((data) => {
    if (session === null) setSession(data);
    if (data.camera_login && currentTab === "home") $("open-report").click();
    const params = new URLSearchParams(location.hash.slice(1));
    const start = window.WebApp?.initDataUnsafe?.start_param
        || new URLSearchParams(params.get("WebAppData") || "").get("start_param")
        || params.get("WebAppStartParam") || new URLSearchParams(location.search).get("WebAppStartParam");
    const match = /^report_(0|[1-9][0-9]{0,18})$/.exec(start || "");
    if (match && data.user) showHistory(match[1]);
}).catch(() => {});
if (tabFromUrl() !== "home") renderLocation();
void showSiteVersion($("site-version"));
