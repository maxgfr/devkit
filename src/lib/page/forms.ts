// Injected into the page: fills every visible form field with plausible test data. Stands alone.

export function fillForms(): number {
  const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;
  const first = pick(["Alice", "Bruno", "Chloé", "David", "Emma", "Farid", "Grace", "Hugo"]);
  const last = pick(["Martin", "Bernard", "Dubois", "Lefèvre", "Moreau", "Garcia", "Nguyen", "Smith"]);
  const n = Math.floor(Math.random() * 9000) + 1000;
  const email = `${first
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")}.${last.toLowerCase()}+${n}@example.com`;
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const guess = (el: HTMLInputElement | HTMLTextAreaElement) => {
    const hint =
      `${el.name} ${el.id} ${el.getAttribute("autocomplete") ?? ""} ${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("aria-label") ?? ""}`.toLowerCase();
    if (/e-?mail/.test(hint)) return email;
    if (/first|given|prénom|prenom/.test(hint)) return first;
    if (/last|family|surname|nom/.test(hint)) return last;
    if (/user|login|pseudo/.test(hint)) return `${first.toLowerCase()}${n}`;
    if (/name/.test(hint)) return `${first} ${last}`;
    if (/phone|tel|mobile/.test(hint)) return `+33 6 ${n.toString().slice(0, 2)} ${n.toString().slice(2)} 12 34`;
    if (/zip|postal|cp\b/.test(hint)) return "75011";
    if (/city|ville|locality/.test(hint)) return "Paris";
    if (/country|pays/.test(hint)) return "France";
    if (/address|adresse|street|rue/.test(hint)) return `${(n % 120) + 1} rue de la Roquette`;
    if (/company|organi|société|societe/.test(hint)) return "Example Corp";
    if (/url|website|site/.test(hint)) return "https://example.com";
    if (/card|cc-number/.test(hint)) return "4242 4242 4242 4242";
    if (/cvc|cvv|csc/.test(hint)) return "123";
    if (/(exp|expiry)/.test(hint)) return "12/30";
    if (/title|subject|objet/.test(hint)) return "Test subject";
    if (/age/.test(hint)) return "34";
    return el instanceof HTMLTextAreaElement
      ? "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Test message from devkit."
      : `Test ${n}`;
  };
  const set = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  let count = 0;
  const visible = (el: HTMLElement) => el.offsetParent !== null || getComputedStyle(el).position === "fixed";
  for (const el of Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"),
  )) {
    if (el.disabled || (el as HTMLInputElement).readOnly || !visible(el)) continue;
    if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options).filter((o) => o.value && !o.disabled);
      if (options.length) {
        set(el, pick(options).value);
        count++;
      }
      continue;
    }
    const type = el instanceof HTMLInputElement ? el.type : "textarea";
    if (["hidden", "submit", "button", "reset", "image", "file"].includes(type)) continue;
    if (type === "checkbox") {
      (el as HTMLInputElement).checked = /terms|cgu|consent|accept|agree/i.test(`${el.name} ${el.id}`) || Math.random() > 0.5;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (type === "radio") {
      const group = document.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${CSS.escape(el.name)}"]`);
      if (!Array.from(group).some((r) => r.checked)) {
        pick(Array.from(group)).click();
      }
    } else if (type === "email") set(el, email);
    else if (type === "password") set(el, `Devkit-${n}-Pass!`);
    else if (type === "number" || type === "range") {
      const input = el as HTMLInputElement;
      const min = Number(input.min || 1);
      const max = Number(input.max || min + 99);
      set(el, String(Math.floor(min + Math.random() * (max - min + 1))));
    } else if (type === "date") set(el, iso(new Date(today.getTime() + 86400000 * 7)));
    else if (type === "datetime-local") set(el, `${iso(today)}T10:30`);
    else if (type === "time") set(el, "10:30");
    else if (type === "month") set(el, iso(today).slice(0, 7));
    else if (type === "color") set(el, "#0e7490");
    else if (type === "tel") set(el, "+33612345678");
    else if (type === "url") set(el, "https://example.com");
    else {
      const max = Number((el as HTMLInputElement).maxLength);
      const v = guess(el as HTMLInputElement);
      set(el, max > 0 ? v.slice(0, max) : v);
    }
    count++;
  }
  return count;
}
