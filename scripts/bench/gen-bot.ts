/**
 * Build a large multi-domain bot (500+ intents) from a brief, straight to data/bots/<id>.
 *
 *   npm run bench:gen-bot -- [--brief bench/brief.json] [--per-domain 8] [--min 500]
 *   npm run bench:gen-bot -- --domains 1                   (smoke test: first area only)
 *   npm run bench:gen-bot -- --topup <botId>               (fill thin areas, retry failed expansions)
 */
import "./env";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BriefSchema, createMultiBot, generateMultiBot, type GenStats } from "../../src/lib/generate-multi";
import { getBot } from "../../src/lib/store";
import { numArg, parseArgs } from "./common";

function printStats(stats: GenStats, perDomain: number, min: number) {
  console.log(`\nIntents: ${stats.total} (depth 1: ${stats.byDepth["1"]}, depth 2: ${stats.byDepth["2"]}, depth 3: ${stats.byDepth["3"]})`);
  console.log("Per area:");
  for (const d of stats.byDomain) {
    const thin = d.top < perDomain ? "  <- thin" : "";
    console.log(`  ${d.name.padEnd(34)} top=${String(d.top).padStart(2)}  total=${String(d.total).padStart(4)}${thin}`);
  }
  if (stats.topWithoutChildren.length) {
    console.log(`Top-level intents with no sub-intents (failed expansion?): ${stats.topWithoutChildren.length}`);
    for (const n of stats.topWithoutChildren.slice(0, 10)) console.log(`  - ${n}`);
  }
  if (stats.notes.length) {
    console.log(`Notes (${stats.notes.length}):`);
    for (const n of stats.notes.slice(0, 20)) console.log(`  - ${n}`);
  }
  if (stats.total < min) {
    console.error(
      `\nFAIL: ${stats.total} intents, below the minimum of ${min}.\n` +
        `Retry thin areas and failed expansions with: npm run bench:gen-bot -- --topup ${stats.botId}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\nOK: ${stats.total} intents (minimum ${min}).`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const perDomain = numArg(args, "per-domain", 8);
  const min = numArg(args, "min", 500);
  const domainLimit = args.domains ? numArg(args, "domains", 0) : undefined;
  const briefPath = path.resolve(args.brief ?? path.join("bench", "brief.json"));
  const brief = BriefSchema.parse(JSON.parse(await fs.readFile(briefPath, "utf8")));
  const log = (msg: string) => console.log(`  ${msg}`);

  if (args.topup && args.topup !== "true") {
    const botId = args.topup;
    const bot = await getBot(botId);
    if (!bot) throw new Error(`Bot ${botId} not found in data/bots`);
    console.log(`Topping up ${bot.name} (${botId}), ${bot.intents.length} intents before`);
    const stats = await generateMultiBot(botId, { brief, perDomain, domainLimit, topup: true, log });
    printStats(stats, perDomain, min);
    return;
  }

  const bot = await createMultiBot(brief);
  console.log(`Generating ${brief.name} (${bot.id}) across ${domainLimit ?? brief.domains.length} areas, ${perDomain} top-level intents each`);
  const stats = await generateMultiBot(bot.id, { brief, perDomain, domainLimit, log });
  printStats(stats, perDomain, min);
  console.log(`\nBot id: ${bot.id}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
