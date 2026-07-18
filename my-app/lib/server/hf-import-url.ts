import { safeImportableFileName } from "@/lib/server/imported-model-registry";

export interface HuggingFaceModelFileUrl {
  url: string;
  fileName: string;
}

const HUGGING_FACE_HOST = "huggingface.co";
const MODEL_FILE_ERROR = "The URL must point to a .gguf, .safetensors, or .bin model file.";

function canonicalHuggingFacePath(segments: string[]): string | null {
  const modeIndex = segments.findIndex((segment) => segment === "resolve" || segment === "blob");
  if (modeIndex < 2) return null;
  if (modeIndex + 2 >= segments.length) return null;
  if (segments[modeIndex] !== "resolve" && segments[modeIndex] !== "blob") return null;

  const canonicalSegments = [...segments];
  canonicalSegments[modeIndex] = "resolve";
  return `/${canonicalSegments.map(encodeURIComponent).join("/")}`;
}

export function resolveHuggingFaceModelFileUrl(
  value: string,
): HuggingFaceModelFileUrl | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: "Enter a valid Hugging Face file URL." };
  }

  if (parsed.protocol !== "https:") {
    return { error: "Hugging Face model downloads must use HTTPS." };
  }
  if (parsed.hostname !== HUGGING_FACE_HOST) {
    return { error: "Only huggingface.co model file URLs are supported." };
  }

  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const canonicalPath = canonicalHuggingFacePath(segments);
  if (!canonicalPath) {
    return { error: "Use a Hugging Face /resolve/ file URL." };
  }

  const fileName = safeImportableFileName(segments.at(-1) ?? "");
  if (!fileName) {
    return { error: MODEL_FILE_ERROR };
  }

  const canonical = new URL("https://huggingface.co");
  canonical.pathname = canonicalPath;
  return { url: canonical.toString(), fileName };
}

