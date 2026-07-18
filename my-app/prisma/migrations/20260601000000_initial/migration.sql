-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProjectCategory" AS ENUM ('STUDIO');

-- CreateEnum
CREATE TYPE "JobSource" AS ENUM ('STUDIO', 'TOOL');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('REFERENCE', 'GENERATED');

-- CreateEnum
CREATE TYPE "AssetModality" AS ENUM ('IMAGE', 'VIDEO', 'MODEL_3D');

-- CreateEnum
CREATE TYPE "ContentOrigin" AS ENUM ('USER', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "CanvasSessionStatus" AS ENUM ('EDITING', 'GENERATING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentTaskStatus" AS ENUM ('BLOCKED_CONFIGURATION', 'QUEUED', 'RUNNING', 'INTERRUPTED', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'UNDONE');

-- CreateEnum
CREATE TYPE "AgentMessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "AgentStepStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AppState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "defaultLocale" TEXT NOT NULL DEFAULT 'en',
    "defaultTextModel" TEXT NOT NULL DEFAULT '',
    "defaultImageModel" TEXT NOT NULL DEFAULT '',
    "defaultVideoModel" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ProjectCategory" NOT NULL,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "templateKey" TEXT,
    "sourceTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferenceSet" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferenceSetAsset" (
    "id" TEXT NOT NULL,
    "referenceSetId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceSetAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "agentTaskId" TEXT,
    "source" "JobSource" NOT NULL,
    "origin" "ContentOrigin" NOT NULL DEFAULT 'USER',
    "toolType" TEXT,
    "prompt" TEXT NOT NULL,
    "referenceCount" INTEGER NOT NULL,
    "requestedCount" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "endpoint" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "type" TEXT NOT NULL DEFAULT 'image',
    "idempotencyKey" TEXT,
    "requestFingerprint" TEXT,
    "videoDuration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "jobId" TEXT NOT NULL,
    "agentTaskId" TEXT,
    "parentAssetId" TEXT,
    "kind" "AssetKind" NOT NULL,
    "origin" "ContentOrigin" NOT NULL DEFAULT 'USER',
    "modality" "AssetModality" NOT NULL DEFAULT 'IMAGE',
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "format" TEXT,
    "durationSeconds" DOUBLE PRECISION,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "summary" TEXT,
    "generationSeed" INTEGER,
    "generationSteps" INTEGER,
    "generationCfg" DOUBLE PRECISION,
    "negativePrompt" TEXT,
    "generationModel" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanvasSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "status" "CanvasSessionStatus" NOT NULL DEFAULT 'EDITING',
    "zoom" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "panX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "panY" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "selectedAssetId" TEXT,
    "drawingState" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanvasSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanvasSnapshot" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanvasSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanvasLayer" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "agentTaskId" TEXT,
    "x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "zIndex" INTEGER NOT NULL DEFAULT 0,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanvasLayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "AgentTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "prompt" TEXT NOT NULL,
    "selectedLayerId" TEXT,
    "textModelId" TEXT,
    "uiContext" JSONB NOT NULL DEFAULT '{}',
    "action" JSONB,
    "capabilityFix" JSONB,
    "error" JSONB,
    "beforeSnapshotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "interruptedAt" TIMESTAMP(3),

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "taskId" TEXT,
    "role" "AgentMessageRole" NOT NULL,
    "parts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTaskStep" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "toolCallId" TEXT,
    "toolName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" "AgentStepStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "artifacts" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "AgentTaskStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_templateKey_key" ON "Project"("templateKey");

-- CreateIndex
CREATE INDEX "Project_userId_category_createdAt_idx" ON "Project"("userId", "category", "createdAt");

-- CreateIndex
CREATE INDEX "Project_userId_isTemplate_updatedAt_idx" ON "Project"("userId", "isTemplate", "updatedAt");

-- CreateIndex
CREATE INDEX "Project_sourceTemplateId_idx" ON "Project"("sourceTemplateId");

-- CreateIndex
CREATE INDEX "ReferenceSet_projectId_createdAt_idx" ON "ReferenceSet"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ReferenceSet_projectId_isDefault_idx" ON "ReferenceSet"("projectId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceSetAsset_referenceSetId_assetId_key" ON "ReferenceSetAsset"("referenceSetId", "assetId");

-- CreateIndex
CREATE INDEX "ReferenceSetAsset_referenceSetId_position_idx" ON "ReferenceSetAsset"("referenceSetId", "position");

-- CreateIndex
CREATE INDEX "ReferenceSetAsset_assetId_idx" ON "ReferenceSetAsset"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationJob_idempotencyKey_key" ON "GenerationJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GenerationJob_userId_projectId_createdAt_idx" ON "GenerationJob"("userId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_status_idx" ON "GenerationJob"("status");

-- CreateIndex
CREATE INDEX "GenerationJob_projectId_idx" ON "GenerationJob"("projectId");

-- CreateIndex
CREATE INDEX "GenerationJob_projectId_origin_createdAt_idx" ON "GenerationJob"("projectId", "origin", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_agentTaskId_idx" ON "GenerationJob"("agentTaskId");

-- CreateIndex
CREATE INDEX "Asset_userId_projectId_kind_createdAt_idx" ON "Asset"("userId", "projectId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_userId_origin_kind_createdAt_idx" ON "Asset"("userId", "origin", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_jobId_createdAt_idx" ON "Asset"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_projectId_idx" ON "Asset"("projectId");

-- CreateIndex
CREATE INDEX "Asset_userId_modality_createdAt_idx" ON "Asset"("userId", "modality", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_userId_isFavorite_createdAt_idx" ON "Asset"("userId", "isFavorite", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_userId_deletedAt_createdAt_idx" ON "Asset"("userId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_agentTaskId_idx" ON "Asset"("agentTaskId");

-- CreateIndex
CREATE INDEX "Asset_parentAssetId_idx" ON "Asset"("parentAssetId");

-- CreateIndex
CREATE INDEX "CanvasSession_userId_projectId_createdAt_idx" ON "CanvasSession"("userId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "CanvasSession_projectId_idx" ON "CanvasSession"("projectId");

-- CreateIndex
CREATE INDEX "CanvasSession_selectedAssetId_idx" ON "CanvasSession"("selectedAssetId");

-- CreateIndex
CREATE INDEX "CanvasSnapshot_sessionId_createdAt_idx" ON "CanvasSnapshot"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "CanvasLayer_sessionId_zIndex_idx" ON "CanvasLayer"("sessionId", "zIndex");

-- CreateIndex
CREATE INDEX "CanvasLayer_assetId_createdAt_idx" ON "CanvasLayer"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "CanvasLayer_agentTaskId_idx" ON "CanvasLayer"("agentTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTask_beforeSnapshotId_key" ON "AgentTask"("beforeSnapshotId");

-- CreateIndex
CREATE INDEX "AgentTask_sessionId_createdAt_idx" ON "AgentTask"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTask_userId_status_updatedAt_idx" ON "AgentTask"("userId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentMessage_sessionId_createdAt_idx" ON "AgentMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentMessage_taskId_createdAt_idx" ON "AgentMessage"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTaskStep_taskId_status_idx" ON "AgentTaskStep"("taskId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTaskStep_taskId_index_key" ON "AgentTaskStep"("taskId", "index");

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_sourceTemplateId_fkey" FOREIGN KEY ("sourceTemplateId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceSet" ADD CONSTRAINT "ReferenceSet_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceSetAsset" ADD CONSTRAINT "ReferenceSetAsset_referenceSetId_fkey" FOREIGN KEY ("referenceSetId") REFERENCES "ReferenceSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceSetAsset" ADD CONSTRAINT "ReferenceSetAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "AgentTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "AgentTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_parentAssetId_fkey" FOREIGN KEY ("parentAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasSession" ADD CONSTRAINT "CanvasSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasSession" ADD CONSTRAINT "CanvasSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasSession" ADD CONSTRAINT "CanvasSession_selectedAssetId_fkey" FOREIGN KEY ("selectedAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasSnapshot" ADD CONSTRAINT "CanvasSnapshot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CanvasSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasLayer" ADD CONSTRAINT "CanvasLayer_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CanvasSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasLayer" ADD CONSTRAINT "CanvasLayer_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasLayer" ADD CONSTRAINT "CanvasLayer_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "AgentTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CanvasSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_beforeSnapshotId_fkey" FOREIGN KEY ("beforeSnapshotId") REFERENCES "CanvasSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CanvasSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTaskStep" ADD CONSTRAINT "AgentTaskStep_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
