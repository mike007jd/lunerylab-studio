// Creator workflow templates — generic image-generation briefs for overseas
// creators.

export type WorkflowCategory = "创意图";

export type CreativeMode = "general" | "photo" | "illustration" | "concept" | "background";

export interface PromptModule {
  id: string;
  label: string;
  content: string;
}

export interface WorkflowTemplate {
  id: string;
  category: WorkflowCategory;
  title: string;
  badge: string;
  summary: string;
  coverImage: string;
  previewTone: "sand" | "mint" | "sky" | "rose" | "lavender" | "sage";
  modules: PromptModule[];
}

// Six generic creator briefs: clean subject, scene-driven hero, detail study,
// multi-angle set, scale reference, copy-ready composition. None are
// vertical-specific — apply to portraits, objects, illustrations, and scenes.
export const CREATIVE_WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "subject-clean",
    category: "创意图",
    title: "干净主体（中性背景）",
    badge: "创意图",
    summary: "主体居中，干净背景，最大化辨识度。",
    coverImage: "/template-covers/main-white-bg.png",
    previewTone: "sand",
    modules: [
      { id: "subject", label: "主体", content: "单一明确主体，比例准确，材质与轮廓清晰，无裁切。" },
      { id: "scene", label: "场景", content: "极简纯色或微渐变背景，无道具，无文字。" },
      { id: "composition", label: "构图", content: "主体居中或贴近视觉黄金区，占画面 70%-85%，安全留白完整。" },
      { id: "lighting", label: "光线", content: "棚拍柔光，阴影自然不刻意，曝光均衡，无过曝。" },
      { id: "constraint", label: "约束", content: "禁止文字、水印、品牌 logo；画面纯粹。" },
      { id: "negative", label: "负向约束", content: "避免变形、避免重复主体、避免背景发灰、避免锯齿边缘。" },
    ],
  },
  {
    id: "scene-hero",
    category: "创意图",
    title: "场景主视觉（氛围感）",
    badge: "创意图",
    summary: "把主体放进一个能讲故事的场景。",
    coverImage: "/template-covers/hero-scene.png",
    previewTone: "mint",
    modules: [
      { id: "subject", label: "主体", content: "主体保持真实比例与质感，与参考图保持一致。" },
      { id: "scene", label: "场景", content: "构建匹配主题的真实场景，前中后景分层，道具简洁不抢戏。" },
      { id: "composition", label: "构图", content: "主体在视觉重心，留出叙事呼吸空间，画面不密堵。" },
      { id: "lighting", label: "光线", content: "主光突出主体轮廓，辅光保留材质细节，色温统一。" },
      { id: "constraint", label: "约束", content: "保持自然真实质感，无夸张滤镜。" },
      { id: "negative", label: "负向约束", content: "避免比例异常、避免噪点、避免伪影、避免廉价质感。" },
    ],
  },
  {
    id: "detail-closeup",
    category: "创意图",
    title: "材质细节（近景特写）",
    badge: "创意图",
    summary: "放大纹理、做工、表面的细节研究。",
    coverImage: "/template-covers/detail-closeup.png",
    previewTone: "sky",
    modules: [
      { id: "subject", label: "主体", content: "聚焦关键纹理 / 工艺区域，呈现真实质感。" },
      { id: "scene", label: "场景", content: "背景极简虚化，色调中性，避免干扰。" },
      { id: "composition", label: "构图", content: "微距近景，主体细节占画面 60%-75%，焦点清晰。" },
      { id: "lighting", label: "光线", content: "侧光或斜侧光强化微结构层次，反光受控。" },
      { id: "constraint", label: "约束", content: "材质真实，不夸大质感。" },
      { id: "negative", label: "负向约束", content: "避免涂抹感、避免锐化过强、避免摩尔纹与噪点。" },
    ],
  },
  {
    id: "multi-angle-set",
    category: "创意图",
    title: "多视角组图（一致性）",
    badge: "创意图",
    summary: "同一主体多角度展示，风格统一可拼接。",
    coverImage: "/template-covers/multi-angle.png",
    previewTone: "rose",
    modules: [
      { id: "subject", label: "主体", content: "同一主体的多视角，外观、颜色、材质、比例保持一致。" },
      { id: "scene", label: "场景", content: "统一背景风格，建议纯色或浅色无纹理。" },
      { id: "composition", label: "构图", content: "前、后、侧、细节四视角，构图节奏统一。" },
      { id: "lighting", label: "光线", content: "统一布光方向，每张图阴影与明暗一致。" },
      { id: "constraint", label: "约束", content: "组图风格可直接拼接展示。" },
      { id: "negative", label: "负向约束", content: "避免角度间主体差异、避免颜色漂移、避免背景跳变。" },
    ],
  },
  {
    id: "scale-reference",
    category: "创意图",
    title: "尺度参照（手持/人物）",
    badge: "创意图",
    summary: "用手或人物给主体一个真实的尺度感。",
    coverImage: "/template-covers/size-compare.png",
    previewTone: "lavender",
    modules: [
      { id: "subject", label: "主体", content: "主体与参照物同框，主体外观保持真实不变。" },
      { id: "scene", label: "场景", content: "简洁中性背景，参照物（手 / 人物）仅作尺寸暗示。" },
      { id: "composition", label: "构图", content: "主体与参照物同框清晰，尺度关系自然可信。" },
      { id: "lighting", label: "光线", content: "自然柔光，保留肤色与材质真实观感。" },
      { id: "constraint", label: "约束", content: "禁止夸张透视造成尺度错觉。" },
      { id: "negative", label: "负向约束", content: "避免手指异常、避免肢体畸形、避免主体悬浮、避免透视夸张。" },
    ],
  },
  {
    id: "copy-ready-layout",
    category: "创意图",
    title: "留白排版（后期可加字）",
    badge: "创意图",
    summary: "为后期叠加文案 / 图形预留干净的留白区。",
    coverImage: "/template-covers/feature-layout.png",
    previewTone: "sage",
    modules: [
      { id: "subject", label: "主体", content: "主体清晰位于视觉中心，关键部位易识别。" },
      { id: "scene", label: "场景", content: "背景干净或轻抽象，色彩克制不抢戏。" },
      { id: "composition", label: "构图", content: "预留 20%-35% 安全留白用于后期排版。" },
      { id: "lighting", label: "光线", content: "主光突出主体，辅光保留边缘与材质细节。" },
      { id: "constraint", label: "约束", content: "图内不直接写文字、不加 logo 与角标。" },
      { id: "negative", label: "负向约束", content: "避免背景杂乱、避免主体遮挡、避免局部糊化。" },
    ],
  },
];

const MODE_PREFIX: Record<CreativeMode, string> = {
  general: "通用创作：围绕同一主题生成清晰、完整、可直接使用的图。",
  photo: "摄影画面：保持主体比例、材质与光线真实自然。",
  illustration: "插画创作：强化画面风格、角色或元素一致性与完整构图。",
  concept: "概念视觉：突出叙事节奏、视觉调性与关键细节。",
  background: "背景生成：为给定主体匹配专业场景，主体本身不变。",
};

export function findWorkflowTemplateById(templateId: string | null | undefined): WorkflowTemplate | null {
  if (!templateId) {
    return null;
  }
  return CREATIVE_WORKFLOW_TEMPLATES.find((item) => item.id === templateId) ?? null;
}

export function buildWorkflowPrompt(template: WorkflowTemplate, mode: CreativeMode): string {
  const moduleText = template.modules.map((module) => `【${module.label}】${module.content}`).join("\n");

  return [
    `生成任务：${MODE_PREFIX[mode]}`,
    `场景模板：${template.title}`,
    moduleText,
    "最终画面要求：写实摄影风格，主体一致，禁止文字与水印，画面精致可直接使用。",
  ].join("\n\n");
}
