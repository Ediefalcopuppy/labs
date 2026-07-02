type Idea = {
  prompt: string;
  twist: string;
  buildTimeMinutes: number;
};

const prompts = [
  "A desk plant that logs its daily mood",
  "A timer that names each focus session",
  "A recipe bot for suspiciously empty fridges",
  "A tiny atlas of imaginary neighborhoods",
  "A command-line postcard maker",
  "A habit tracker for delightfully specific rituals",
];

const twists = [
  "must fit in one screen",
  "prints a tiny ASCII receipt at the end",
  "uses only the current time as input",
  "has three modes: practical, poetic, and chaotic",
  "gives every result a dramatic title",
  "ends with one useful next step",
];

function hashSeed(seed: string): number {
  return [...seed].reduce((hash, char) => {
    return (hash * 31 + char.charCodeAt(0)) >>> 0;
  }, 17);
}

function pick<T>(items: T[], seed: number, offset: number): T {
  return items[(seed + offset) % items.length];
}

function makeIdea(seedText: string): Idea {
  const seed = hashSeed(seedText);

  return {
    prompt: pick(prompts, seed, 0),
    twist: pick(twists, seed, 3),
    buildTimeMinutes: 15 + (seed % 46),
  };
}

function renderIdea(idea: Idea, seedText: string): string {
  return [
    "Tiny TypeScript Idea Machine",
    "============================",
    `Seed: ${seedText}`,
    "",
    `Build: ${idea.prompt}`,
    `Rule: It ${idea.twist}.`,
    `Timebox: ${idea.buildTimeMinutes} minutes`,
    "",
    "First move: create the smallest version that makes you smile.",
  ].join("\n");
}

const seedText = Bun.argv.slice(2).join(" ") || new Date().toDateString();
const idea = makeIdea(seedText);

console.log(renderIdea(idea, seedText));
