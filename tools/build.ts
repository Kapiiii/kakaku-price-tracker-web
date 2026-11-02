const root = new URL("../", import.meta.url);
await Deno.mkdir(new URL("docs/vendor/", root), { recursive: true });
for (
  const args of [
    ["bundle", "--platform=browser", "--minify", "--output=docs/vendor/supabase.js", "tools/client-entry.js"],
    ["bundle", "--platform=deno", "--output=DEPLOY_FUNCTION.js", "supabase/functions/tracker-api/index.ts"],
    [
      "bundle",
      "--platform=deno",
      "--output=DEPLOY_DAILY_FUNCTION.js",
      "supabase/functions/tracker-daily/index.ts",
    ],
  ]
) {
  const result = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) Deno.exit(1);
}
console.log("GitHub Pagesの画面と、Supabase用の単一ファイルを生成しました。");
const info = await new Deno.Command(Deno.execPath(), {
  args: ["info", "--json", "tools/client-entry.js"],
  cwd: root,
  stdout: "piped",
  stderr: "inherit",
}).output();
if (!info.success) Deno.exit(1);
const packages = Object.values(JSON.parse(new TextDecoder().decode(info.stdout)).npmPackages ?? {}) as {
  name: string;
  version: string;
  localPath: string;
}[];
const notices = [
  "# Third-party notices\n\n本番・開発依存に含まれるライブラリのライセンスです。アプリ本体のライセンスは未指定です。\n",
];
for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name))) {
  const manifest = JSON.parse(await Deno.readTextFile(`${pkg.localPath}/package.json`));
  const licenseFiles: string[] = [];
  for await (const entry of Deno.readDir(pkg.localPath)) {
    if (entry.isFile && /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name)) licenseFiles.push(entry.name);
  }
  notices.push(
    `\n## ${pkg.name} ${pkg.version}\n\nLicense: ${
      JSON.stringify(manifest.license ?? "See package license")
    }\n`,
  );
  for (const name of licenseFiles) {
    notices.push(
      `\n### ${name}\n\n\`\`\`text\n${await Deno.readTextFile(`${pkg.localPath}/${name}`)}\n\`\`\`\n`,
    );
  }
}
await Deno.writeTextFile(new URL("THIRD_PARTY_NOTICES.md", root), notices.join("\n"));
