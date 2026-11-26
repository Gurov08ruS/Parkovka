import { element } from "./ui.js";

const banNotice = "Автоматически отклонено из-за блокировки аккаунта";

export const statuses = {
    draft: "Черновик",
    pending: "Ожидает проверки",
    under_review: "На проверке",
    approved: "Проверено",
    rejected: "Отклонено",
    withdrawn: "Отозвано",
};

function dateLabel(value) {
    return value ? new Date(value).toLocaleString("ru-RU") : "";
}

function placeLabel(report) {
    if (report.address) return report.address;
    if (report.latitude !== null) return `${report.latitude.toFixed(5)}, ${report.longitude.toFixed(5)}`;
    return "Местоположение отсутствует";
}

function reportStatus(report) {
    return element("span", statuses[report.status] || report.status, `report-status status-${report.status}`);
}

function appendBanNotice(container, report, banLink) {
    if (!report.auto_rejected) return;
    const notice = element("p", banNotice, "report-ban-notice");
    if (banLink && report.ban_report_id) {
        const link = element("a", `Обращение №${report.ban_report_id}, из-за которого заблокировали аккаунт`);
        link.href = banLink(report.ban_report_id);
        notice.append(element("br"), link);
    }
    container.append(notice);
}

export function reviewPageUrl(identifier) {
    const url = new URL("/review.html", location.href);
    if (identifier) url.searchParams.set("report", identifier);
    url.hash = location.hash;
    return url.href;
}

export function decisionStats(stats) {
    const list = element("dl", "", "decision-stats");
    for (const [key, label] of [["approved", "Принято"], ["rejected", "Отклонено"], ["withdrawn", "Отозвано"]]) {
        if (!Object.hasOwn(stats, key)) continue;
        const item = element("div");
        item.append(element("dt", label), element("dd", stats[key], `status-${key}`));
        list.append(item);
    }
    return list;
}

export function reportCard(report, path, control, banLink) {
    const card = element("article", "", "report-card");
    const heading = element("div", "", "report-card-head");
    heading.append(element("strong", `Обращение №${report.id}`), reportStatus(report));
    card.append(heading, element("small", `${placeLabel(report)} · ${dateLabel(report.submitted_at || report.created_at)}`));
    appendBanNotice(card, report, banLink);
    if (report.plate_number) {
        card.append(element("p", `Госномер: ${report.plate_number} · Не подтверждён`, "report-plate-summary"));
    }
    if (report.has_photo) {
        const gallery = element("div", "", "report-photos");
        for (const [exists, kind, alt] of [[report.has_photo, "overview", "Основной снимок"], [report.has_detail_photo, "detail", "Дополнительный снимок"]]) {
            if (!exists) continue;
            const image = element("img");
            image.src = `${path}/photos/${kind}`;
            image.alt = alt;
            gallery.append(image);
        }
        card.append(gallery);
    }
    card.append(control);
    return card;
}

export function appendReportDetails(container, report, path, banLink) {
    container.append(reportStatus(report));
    appendBanNotice(container, report, banLink);
    container.append(
        element("p", placeLabel(report)),
        element("p", `Создано ${dateLabel(report.created_at)}`),
    );
    if (report.captured_at) container.append(element("p", `Снято ${dateLabel(report.captured_at)}`));
    if (report.plate_number) {
        const plate = element("div", "", "report-plate-summary");
        plate.append(element("strong", report.plate_number), element("span", "Не подтверждён"));
        container.append(plate);
    }
    if (report.comment) container.append(element("p", report.comment, "report-comment"));
    const gallery = element("div", "", "report-photos");
    for (const [exists, kind, label] of [
        [report.has_photo, "overview", "Основной снимок"],
        [report.has_detail_photo, "detail", "Дополнительный снимок"],
    ]) {
        if (!exists) continue;
        const image = element("img");
        image.src = `${path}/photos/${kind}`;
        image.alt = label;
        const figure = element("figure");
        figure.append(image, element("figcaption", label));
        gallery.append(figure);
    }
    if (gallery.children.length) container.append(gallery);
    if (report.events.length) {
        const log = element("ol", "", "report-events");
        for (const entry of report.events) {
            const item = element("li", `${statuses[entry.status]} · ${dateLabel(entry.occurred_at)}`);
            if (entry.note) {
                const note = entry.note === `${banNotice}.` ? banNotice : entry.note;
                item.append(element("p", note, "report-comment"));
            }
            log.append(item);
        }
        container.append(element("h3", "История статусов"), log);
    }
}
