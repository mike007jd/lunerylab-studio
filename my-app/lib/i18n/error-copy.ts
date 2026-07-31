"use client";

import { useMemo } from "react";
import { normalizeLocale, type Locale } from "@/lib/i18n/locale";

/**
 * Static copy table for error boundaries (route + global). Used in places
 * where the I18nProvider may itself have crashed, so depending on `useT()`
 * would risk a second crash during recovery. Both `app/error.tsx` and
 * `app/global-error.tsx` consume this single source of truth.
 */
const ERROR_COPY = {
  en: {
    title: "Something went wrong",
    unexpected: "An unexpected error occurred.",
    retry: "Try again",
    resetWorkspace: "Delete workspace data",
    resetWorkspaceDescription: "Permanently delete every project, canvas, media file, Trash item, and recovery copy? Local models and service connections stay.",
    confirmResetWorkspace: "Delete workspace data",
    resettingWorkspace: "Deleting and restarting…",
    resetWorkspaceFailed: "Could not delete the workspace. Try again or use Open data folder.",
    openDataFolder: "Open data folder",
    openingDataFolder: "Opening…",
    openDataFolderFailed: "Could not open the local data folder.",
    cancel: "Cancel",
  },
  "zh-CN": {
    title: "出了点问题",
    unexpected: "发生了意外错误。",
    retry: "重试",
    resetWorkspace: "删除工作区数据",
    resetWorkspaceDescription: "永久删除全部项目、画布、媒体文件、回收站内容和恢复副本？本地模型与服务连接会保留。",
    confirmResetWorkspace: "删除工作区数据",
    resettingWorkspace: "正在删除并重启…",
    resetWorkspaceFailed: "无法删除工作区。请重试，或使用“打开数据目录”。",
    openDataFolder: "打开数据目录",
    openingDataFolder: "打开中…",
    openDataFolderFailed: "无法打开本机数据目录。",
    cancel: "取消",
  },
  "zh-TW": {
    title: "出了點問題",
    unexpected: "發生了意外錯誤。",
    retry: "重試",
    resetWorkspace: "刪除工作區資料",
    resetWorkspaceDescription: "永久刪除全部專案、畫布、媒體檔案、回收站內容和復原副本？本機模型與服務連線會保留。",
    confirmResetWorkspace: "刪除工作區資料",
    resettingWorkspace: "正在刪除並重新啟動…",
    resetWorkspaceFailed: "無法刪除工作區。請重試，或使用「開啟資料目錄」。",
    openDataFolder: "開啟資料目錄",
    openingDataFolder: "開啟中…",
    openDataFolderFailed: "無法開啟本機資料目錄。",
    cancel: "取消",
  },
} as const;

export type ErrorCopy = (typeof ERROR_COPY)[Locale];

export function useErrorCopy(): ErrorCopy {
  return useMemo(() => {
    const locale =
      typeof window === "undefined"
        ? "en"
        : normalizeLocale(window.navigator.language) ?? "en";
    return ERROR_COPY[locale];
  }, []);
}
