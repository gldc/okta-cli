import db from "../assets/wordlist.sqlite" with { type: "sqlite", embed: "true" };

export function generatePassword(numWords: number, lang = "en"): string[] {
  const rows = db.query("SELECT word FROM word WHERE lang = ? ORDER BY random() LIMIT ?").all(lang, numWords) as { word: string }[];
  return rows.map((r) => r.word.trim());
}

export function buildPassphrase(words: string[], minLength: number): string {
  const capitalized = words.length > 0 ? [`${words[0]!.charAt(0).toUpperCase()}${words[0]!.slice(1)}`, ...words.slice(1)] : words;
  const digit = String(Math.floor(Math.random() * 10));
  let pw = `${capitalized.join(" ")}${digit}`;
  for (let i = 3; i <= capitalized.length; i++) {
    pw = `${capitalized.slice(0, i).join(" ")}${digit}`;
    if (pw.length >= minLength) break;
  }
  return pw;
}
