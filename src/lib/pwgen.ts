import db from "../assets/wordlist.sqlite" with { type: "sqlite", embed: "true" };

export function generatePassword(numWords: number, lang = "en"): string[] {
  const rows = db.query("SELECT word FROM word WHERE lang = ? ORDER BY random() LIMIT ?").all(lang, numWords) as { word: string }[];
  return rows.map((r) => r.word.trim());
}

export function buildPassphrase(words: string[], minLength: number): string {
  let pw = words.join(" ");
  for (let i = 3; i <= words.length; i++) {
    pw = words.slice(0, i).join(" ");
    if (pw.length >= minLength) break;
  }
  return pw;
}
