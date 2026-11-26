import { request, initData, needsMax, withTimeout, loadSession, logoutSession, element, statusMessage, profileAvatar, button, submitButton, field, formHandler, panelLink, maxBotLink } from "./ui.js";
import { appendReportDetails, reportCard, decisionStats, reviewPageUrl } from "./report-view.js";

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
    if (previousUser?.max_id !== user?.max_id || previousUser?.first_name !== user?.first_name
        || previousUser?.last_name !== user?.last_name || previousUser?.photo_url !== user?.photo_url) {
        profileTabIcon.replaceChildren(user ? profileAvatar(user, "П") : defaultProfileIcon);
    }
    browserNotice.hidden = !needsMax(data);
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

export async function requireAccount(action) {
    const version = panelVersion;
    try {
        if (loginRequest) await loginRequest;
        const data = await loadSession();
        if (version !== panelVersion) return;
        setSession(data);
    } catch (error) {
        if (version !== panelVersion) return;
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

function showAchievements() {
    openPanel("Мои достижения");
    panelContent.append(element("p", "Здесь собраны достижения, которые можно получить во время использования сервиса. Начисление достижений находится в разработке"));
    const grid = element("div", "", "achievement-grid");
    for (const [icon, title, description] of [
        ["★", "Первый шаг", "За первое отправленное обращение"],
        ["◉", "Чёткий кадр", "За два качественных снимка"],
        ["☁", "Всегда на связи", "За успешную синхронизацию"],
        ["⌖", "Внимательный наблюдатель", "За точные координаты и время"],
        ["✓", "Знаю правила", "За ознакомление с правилами сервиса"],
        ["♡", "Надёжный помощник", "За ответственное использование сервиса"],
    ]) {
        const card = element("article", "", "achievement-card");
        const badge = element("span", icon, "achievement-icon");
        badge.setAttribute("aria-hidden", "true");
        card.append(badge, element("strong", title), element("p", description));
        grid.append(card);
    }
    panelContent.append(grid);
}

async function showList(filter = "sent") {
    const version = openPanel("Мои обращения");
    const filters = element("div", "", "report-filter");
    for (const [name, label] of [["sent", "Отправленные"], ["drafts", "Черновики"]]) {
        const control = button(label, () => navigate("history", undefined, name), filter === name);
        control.setAttribute("aria-pressed", String(filter === name));
        filters.append(control);
    }
    const message = statusMessage("Загружаем обращения…");
    panelContent.append(filters, message);
    try {
        const { reports } = await request("/api/reports");
        if (!activePanel(version)) return;
        const visible = reports.filter((report) => {
            const draft = report.status === "draft" || (report.auto_rejected && !report.submitted_at);
            return draft === (filter === "drafts");
        });
        if (visible.length === 0) {
            message.classList.add("empty-card");
            message.textContent = filter === "drafts"
                ? "Черновиков пока нет" : "Пока нет обращений. После отправки здесь появится их история и статус";
            return;
        }
        message.remove();
        for (const report of visible) {
            const control = button("Подробнее об обращении", () => showDetails(report.id, filter));
            panelContent.append(reportCard(report, `/api/reports/${report.id}`, control));
        }
    } catch (error) {
        if (!activePanel(version)) return;
        message.textContent = error.message;
        panelContent.append(button("Повторить", () => showList(filter)));
    }
}

export function showHistory(identifier, filter) {
    navigate("history", identifier, filter);
}

async function showDetails(identifier, filter = "sent") {
    const version = openPanel(`Обращение №${identifier}`);
    const message = statusMessage("Загружаем обращение…");
    panelContent.append(button("К списку", () => showList(filter)), message);
    const path = `/api/reports/${identifier}`;
    try {
        const report = await request(path);
        if (!activePanel(version)) return;
        message.remove();
        appendReportDetails(panelContent, report, path);
        if (report.capture_id && editDraft) {
            panelContent.append(button("Продолжить черновик", () => editDraft(report), true));
        }
        if (["pending", "under_review"].includes(report.status)) {
            const confirmation = element("details", "", "withdraw-report");
            const form = element("form", "", "panel-stack");
            const feedback = statusMessage();
            form.append(element("p", "После отзыва обращение снимут с проверки. Оно останется в вашей истории."),
                submitButton("Подтвердить отзыв"), feedback);
            formHandler(form, feedback, `${path}/withdraw`, () => {
                if (activePanel(version)) return showDetails(identifier, filter);
            });
            confirmation.append(element("summary", "Отозвать обращение"), form);
            panelContent.append(confirmation);
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
    requireAccount(() => {
        if (identifier) showDetails(identifier);
        else showList(filter);
    });
}

function tabUrl(tab, filter) {
    const url = new URL(location.href);
    if (tab === "home") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    if (tab === "history" && filter === "drafts") url.searchParams.set("filter", "drafts");
    else url.searchParams.delete("filter");
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
    if (tab === "profile" && (review === "queue" || /^[1-9][0-9]{0,18}$/.test(review))) {
        location.replace(reviewPageUrl(review === "queue" ? undefined : review));
        return;
    }
    renderTab(tab, undefined, params.get("filter") === "drafts" ? "drafts" : "sent");
}

for (const tab of Object.keys(tabTitles)) {
    $("open-" + tab).addEventListener("click", () => navigate(tab));
}
window.addEventListener("popstate", renderLocation);
$("open-about").addEventListener("click", showAbout);
const parkingWarning = $("parking-warning");
let warningClickAnimation;
parkingWarning.addEventListener("click", () => {
    warningClickAnimation?.cancel();
    if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) return;
    warningClickAnimation = parkingWarning.firstElementChild.animate?.([
        { transform: "scale(1)" },
        { transform: "scale(.92)", offset: .24 },
        { transform: "scale(1.08)", offset: .6 },
        { transform: "scale(1)" },
    ], { duration: 360, easing: "ease-in-out" });
});
loadSession().then((data) => {
    if (session === null) setSession(data);
}).catch(() => {});
if (tabFromUrl() !== "home") renderLocation();
