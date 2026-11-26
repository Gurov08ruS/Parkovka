import { request, initData, needsMax, loadSession, element, statusMessage, button, submitButton, field, formHandler, panelLink, maxBotLink } from "./ui.js";
import { appendReportDetails, reportCard, decisionStats, reviewPageUrl, statuses } from "./report-view.js";

const content = document.getElementById("review-content");
const title = document.getElementById("review-title");
const account = document.getElementById("review-account");
const storageWarning = document.getElementById("review-storage-warning");
const siteLink = document.getElementById("site-link");
siteLink.hash = location.hash;
const reportParam = new URLSearchParams(location.search).get("report");
const reportId = /^[1-9][0-9]{0,18}$/.test(reportParam) ? reportParam : null;
let version = 0;
let storageTimer;

async function refreshStorageWarning(current) {
    try {
        const { low_space } = await request("/api/review/storage");
        if (current === version) storageWarning.hidden = !low_space;
    } catch (error) {
        if (current !== version) return;
        if (error.status === 401 || error.status === 403) {
            storageWarning.hidden = true;
            return;
        }
    }
    if (current === version) storageTimer = setTimeout(() => refreshStorageWarning(current), 60_000);
}

function showLogin({ mode, user }) {
    const form = element("form", "", "panel-stack");
    const message = statusMessage();
    if (user) {
        title.textContent = "Вход для проверяющего";
        form.append(field("Секрет проверяющего", "key", { type: "password", required: true }));
        formHandler(form, message, "/api/reviewer", loadPage);
    } else {
        title.textContent = "Вход в аккаунт";
        if (needsMax({ mode, user })) {
            content.replaceChildren(statusMessage("Откройте бота в MAX, чтобы зарегистрироваться и войти."), maxBotLink());
            return;
        }
        formHandler(form, message, "/api/session", loadPage, () => mode === "test" ? {} : { init_data: initData() });
    }
    form.append(submitButton(user ? "Войти" : mode === "test" ? "Войти в тестовом режиме" : "Войти через MAX"), message);
    content.replaceChildren(form);
}

async function showAccount(user, current) {
    const message = statusMessage("Загружаем статистику…");
    account.hidden = false;
    account.replaceChildren(
        element("h2", `${user.first_name} ${user.last_name}`.trim() || `ID MAX: ${user.max_id}`),
        element("p", "Мои решения"),
        message,
    );
    try {
        const stats = await request("/api/review/stats");
        if (current === version) message.replaceWith(decisionStats(stats));
    } catch (error) {
        if (current === version) message.textContent = error.message;
    }
}

async function showQueue(current) {
    const { reports } = await request("/api/review");
    if (current !== version) return;
    if (!reports.length) {
        content.replaceChildren(element("p", "В очереди пока нет обращений", "empty-card"));
        return;
    }
    const grid = element("div", "", "review-grid");
    for (const report of reports) {
        const link = panelLink("Подробнее об обращении", reviewPageUrl(report.id));
        grid.append(reportCard(report, `/api/review/${report.id}`, link, reviewPageUrl));
    }
    content.replaceChildren(grid);
}

function authorControls(report, path) {
    const author = report.author;
    const card = element("section", "", "panel-stack capture-section");
    card.append(
        element("h3", "Автор обращения"),
        element("p", author.max_id.startsWith("test-") ? "Тестовый аккаунт" : `ID MAX: ${author.max_id}`),
        element("p", author.banned ? "Аккаунт заблокирован" : "Аккаунт активен"),
        decisionStats(author.stats),
    );
    if (author.banned && author.ban_reason) {
        card.append(element("p", `Причина: ${author.ban_reason}`, "report-comment"));
    }
    const form = element("form", "", "panel-stack");
    if (!author.banned) {
        form.append(
            element("p", "При блокировке все обращения автора будут автоматически отклонены"),
            field("Причина блокировки", "reason", { multiline: true, maxLength: 1000, required: true }),
        );
    }
    const message = statusMessage();
    form.append(submitButton(author.banned ? "Разблокировать аккаунт" : "Заблокировать аккаунт"), message);
    formHandler(form, message, `${path}/author-ban`, loadPage, ({ reason }) => ({
        banned: !author.banned,
        reason: reason || "",
    }));
    card.append(form);
    return card;
}

function reviewForm(report, path) {
    const form = element("form", "", "panel-stack capture-section");
    const label = element("label", "Новый статус");
    const select = element("select");
    select.name = "status";
    const choices = report.status === "pending" ? ["under_review", "approved", "rejected"] : ["approved", "rejected"];
    for (const value of choices) {
        const option = element("option", statuses[value]);
        option.value = value;
        select.append(option);
    }
    label.append(select);
    const note = field("Комментарий к решению. Для отказа обязателен", "note", { multiline: true, maxLength: 1000 });
    select.addEventListener("change", () => {
        note.querySelector("textarea").required = select.value === "rejected";
    });
    const message = statusMessage();
    form.append(element("h3", "Решение проверяющего"), label, note, submitButton("Сохранить решение"), message);
    formHandler(form, message, `${path}/status`, loadPage);
    return form;
}

async function showReport(current) {
    const path = `/api/review/${reportId}`;
    const report = await request(path);
    if (current !== version) return;
    const details = element("article", "", "panel-stack capture-section");
    appendReportDetails(details, report, path, reviewPageUrl);
    const actions = element("div", "", "panel-stack");
    if (["pending", "under_review"].includes(report.status)) actions.append(reviewForm(report, path));
    actions.append(authorControls(report, path));
    const columns = element("div", "", "review-columns");
    columns.append(details, actions);
    content.replaceChildren(panelLink("К списку", reviewPageUrl()), columns);
}

async function loadPage() {
    const current = ++version;
    clearTimeout(storageTimer);
    storageWarning.hidden = true;
    content.replaceChildren(statusMessage("Загрузка…"));
    title.hidden = true;
    try {
        const session = await loadSession();
        if (current !== version) return;
        if (!session.user?.reviewer) {
            account.hidden = true;
            const canSignIn = session.review_enabled || needsMax(session);
            title.hidden = !canSignIn;
            if (canSignIn) showLogin(session);
            else content.replaceChildren(statusMessage("Кабинет проверяющего недоступен"));
            return;
        }
        title.textContent = reportId ? `Обращение №${reportId}` : "Очередь проверки";
        title.hidden = false;
        void refreshStorageWarning(current);
        await Promise.all([showAccount(session.user, current), reportId ? showReport(current) : showQueue(current)]);
    } catch (error) {
        if (current !== version) return;
        content.replaceChildren(statusMessage(error.message));
        if (reportId) content.append(panelLink("К списку", reviewPageUrl()));
        content.append(button("Повторить", loadPage));
    }
}

loadPage();
