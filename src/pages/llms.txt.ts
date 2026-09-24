import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { getSortedPosts } from "@/utils/getSortedPosts";
import { getPostUrl } from "@/utils/getPostPaths";
import config from "@/config";

export const GET: APIRoute = async ({ site }) => {
  const posts = getSortedPosts(await getCollection("posts"));

  const lines = [
    `# ${config.site.title}`,
    "",
    `> ${config.site.description}`,
    "",
    "## Posts",
    "",
    ...posts.map(({ data, id, filePath }) => {
      const url = new URL(getPostUrl(id, filePath, config.site.lang), site).href;
      return `- [${data.title}](${url}): ${data.description}`;
    }),
    "",
    "## Optional",
    "",
    `- [RSS feed](${new URL("rss.xml", site).href})`,
    `- [Sitemap](${new URL("sitemap-index.xml", site).href})`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
