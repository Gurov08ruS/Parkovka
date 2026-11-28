export function setPlateBoxes(image, boxes = []) {
    let frame = image.parentElement;
    if (!frame?.classList.contains("plate-photo")) {
        frame = document.createElement("span");
        frame.className = "plate-photo";
        image.before(frame);
        frame.append(image);
    }
    frame.querySelectorAll(".plate-detection").forEach((box) => box.remove());
    for (const box of boxes) {
        if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) continue;
        const [x1, y1, x2, y2] = box;
        if (x1 < 0 || y1 < 0 || x2 > 1 || y2 > 1 || x2 <= x1 || y2 <= y1) continue;
        const marker = document.createElement("span");
        marker.className = "plate-detection";
        marker.setAttribute("aria-hidden", "true");
        Object.assign(marker.style, { left: `${x1 * 100}%`, top: `${y1 * 100}%`,
            width: `${(x2 - x1) * 100}%`, height: `${(y2 - y1) * 100}%` });
        frame.append(marker);
    }
}

export async function loadPlateBoxes(image, url) {
    try {
        const response = await fetch(`${url}/boxes`);
        if (!response.ok) return;
        const { boxes } = await response.json();
        if (image.isConnected) setPlateBoxes(image, boxes);
        return boxes;
    } catch {
    }
}
