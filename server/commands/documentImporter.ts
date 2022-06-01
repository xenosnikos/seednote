import path from "path";
import emojiRegex from "emoji-regex";
import { strikethrough, tables } from "joplin-turndown-plugin-gfm";
import { truncate } from "lodash";
import mammoth from "mammoth";
import quotedPrintable from "quoted-printable";
import { Transaction } from "sequelize";
import TurndownService from "turndown";
import utf8 from "utf8";
import { MAX_TITLE_LENGTH } from "@shared/constants";
import parseTitle from "@shared/utils/parseTitle";
import { APM } from "@server/logging/tracing";
import { User } from "@server/models";
import dataURItoBuffer from "@server/utils/dataURItoBuffer";
import parseImages from "@server/utils/parseImages";
import { FileImportError, InvalidRequestError } from "../errors";
import attachmentCreator from "./attachmentCreator";

// https://github.com/domchristie/turndown#options
const turndownService = new TurndownService({
  hr: "---",
  bulletListMarker: "-",
  headingStyle: "atx",
}).remove(["script", "style", "title", "head"]);

// Use the GitHub-flavored markdown plugin to parse
// strikethoughs and tables
turndownService
  .use(strikethrough)
  .use(tables)
  .addRule("breaks", {
    filter: ["br"],
    replacement: function () {
      return "\n";
    },
  });

interface ImportableFile {
  type: string;
  getMarkdown: (content: Buffer | string) => Promise<string>;
}

const importMapping: ImportableFile[] = [
  {
    type: "application/msword",
    getMarkdown: confluenceToMarkdown,
  },
  {
    type: "application/octet-stream",
    getMarkdown: docxToMarkdown,
  },
  {
    type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    getMarkdown: docxToMarkdown,
  },
  {
    type: "text/html",
    getMarkdown: htmlToMarkdown,
  },
  {
    type: "text/plain",
    getMarkdown: fileToMarkdown,
  },
  {
    type: "text/markdown",
    getMarkdown: fileToMarkdown,
  },
];

async function fileToMarkdown(content: Buffer | string): Promise<string> {
  if (content instanceof Buffer) {
    content = content.toString("utf8");
  }
  return content;
}

async function docxToMarkdown(content: Buffer | string): Promise<string> {
  if (content instanceof Buffer) {
    const { value: html } = await mammoth.convertToHtml({ buffer: content });
    return turndownService.turndown(html);
  }

  throw new Error("docxToMarkdown: content must be a Buffer");
}

async function htmlToMarkdown(content: Buffer | string): Promise<string> {
  if (content instanceof Buffer) {
    content = content.toString("utf8");
  }

  return turndownService.turndown(content);
}

async function confluenceToMarkdown(value: Buffer | string): Promise<string> {
  if (value instanceof Buffer) {
    value = value.toString("utf8");
  }

  // We're only supporting the ridiculous output from Confluence here, regular
  // Word documents should call into the docxToMarkdown importer.
  // See: https://jira.atlassian.com/browse/CONFSERVER-38237
  if (!value.includes("Content-Type: multipart/related")) {
    throw FileImportError("Unsupported Word file");
  }

  // get boundary marker
  const boundaryMarker = value.match(/boundary="(.+)"/);

  if (!boundaryMarker) {
    throw FileImportError("Unsupported Word file (No boundary marker)");
  }

  // get content between multipart boundaries
  let boundaryReached = 0;
  const lines = value.split("\n").filter((line) => {
    if (line.includes(boundaryMarker[1])) {
      boundaryReached++;
      return false;
    }

    if (line.startsWith("Content-")) {
      return false;
    }

    // 1 == definition
    // 2 == content
    // 3 == ending
    if (boundaryReached === 2) {
      return true;
    }

    return false;
  });

  if (!lines.length) {
    throw FileImportError("Unsupported Word file (No content found)");
  }

  // Mime attachment is "quoted printable" encoded, must be decoded first
  // https://en.wikipedia.org/wiki/Quoted-printable
  value = utf8.decode(quotedPrintable.decode(lines.join("\n")));

  // If we don't remove the title here it becomes printed in the document
  // body by turndown
  turndownService.remove(["style", "title"]);

  // Now we should have something that looks like HTML
  const html = turndownService.turndown(value);
  return html.replace(/<br>/g, " \\n ");
}

async function documentImporter({
  mimeType,
  fileName,
  content,
  user,
  ip,
  transaction,
}: {
  user: User;
  mimeType: string;
  fileName: string;
  content: Buffer | string;
  ip?: string;
  transaction?: Transaction;
}): Promise<{
  text: string;
  title: string;
}> {
  const fileInfo = importMapping.filter((item) => {
    if (item.type === mimeType) {
      if (
        mimeType === "application/octet-stream" &&
        path.extname(fileName) !== ".docx"
      ) {
        return false;
      }

      return true;
    }

    if (item.type === "text/markdown" && path.extname(fileName) === ".md") {
      return true;
    }

    return false;
  })[0];

  if (!fileInfo) {
    throw InvalidRequestError(`File type ${mimeType} not supported`);
  }

  let title = fileName.replace(/\.[^/.]+$/, "");
  let text = await fileInfo.getMarkdown(content);
  text = text.trim();

  // find and extract first emoji, in the case of some imports it can be outside
  // of the title, at the top of the document.
  const regex = emojiRegex();
  const matches = regex.exec(text);
  const firstEmoji = matches ? matches[0] : undefined;
  if (firstEmoji && text.startsWith(firstEmoji)) {
    text = text.replace(firstEmoji, "").trim();
  }

  // If the first line of the imported text looks like a markdown heading
  // then we can use this as the document title
  if (text.startsWith("# ")) {
    const result = parseTitle(text);
    title = result.title;
    text = text.replace(`# ${title}\n`, "");
  }

  // If we parsed an emoji from _above_ the title then add it back at prefixing
  if (firstEmoji) {
    title = `${firstEmoji} ${title}`;
  }

  // find data urls, convert to blobs, upload and write attachments
  const images = parseImages(text);
  const dataURIs = images.filter((href) => href.startsWith("data:"));

  for (const uri of dataURIs) {
    const name = "imported";
    const { buffer, type } = dataURItoBuffer(uri);
    const attachment = await attachmentCreator({
      name,
      type,
      buffer,
      user,
      ip,
      transaction,
    });
    text = text.replace(uri, attachment.redirectUrl);
  }

  // It's better to truncate particularly long titles than fail the import
  title = truncate(title, { length: MAX_TITLE_LENGTH });

  return {
    text,
    title,
  };
}

export default APM.traceFunction({
  serviceName: "command",
  spanName: "documentImporter",
})(documentImporter);
