export type PresetCategory = "photography" | "illustration" | "ui-design" | "3d-render" | "social" | "batch";

export type StylePresetId =
  | "commercial-photo"
  | "lifestyle"
  | "flat-lay"
  | "flat-illustration"
  | "watercolor"
  | "minimal-ui"
  | "glass-ui"
  | "dark-luxury-ui"
  | "object-3d"
  | "social-launch"
  | "social-og"
  | "social-banner"
  | "batch-scene-variants"
  | "batch-style-transfer"
  | "batch-creative-set";

export interface BatchVariant {
  key: string;
  label: string;
  labelZh: string;
  promptSuffix: string;
}

export interface PresetDefaults {
  aspectRatio?: string;
  count?: number;
}

export interface StylePreset {
  id: StylePresetId;
  category: PresetCategory;
  name: string;
  nameZh: string;
  description: string;
  descriptionZh: string;
  keywords: string[];
  promptGuidance: string;
  coverImage: string;
  previewTone: "sand" | "mint" | "sky" | "rose" | "lavender" | "sage";
  defaults?: PresetDefaults;
  /** When set, selecting this preset generates one image per variant concurrently. */
  batchVariants?: BatchVariant[];
}

export const STYLE_PRESETS: StylePreset[] = [
  // ── Photography ──
  {
    id: "commercial-photo",
    category: "photography",
    name: "Studio Photo",
    nameZh: "影棚摄影",
    description: "Professional studio shot, clean background, subject-focused.",
    descriptionZh: "专业棚拍、干净背景、主体突出。",
    keywords: ["studio", "clean", "subject", "professional"],
    promptGuidance:
      "Professional photography style. Studio lighting with soft shadows, clean solid or gradient background, main subject as the hero, sharp focus on details, realistic material textures, no watermarks, no brand logos.",
    coverImage: "/preset-covers/lifestyle.png",
    previewTone: "sand",
    defaults: { aspectRatio: "1:1", count: 1 },
  },
  {
    id: "lifestyle",
    category: "photography",
    name: "Lifestyle",
    nameZh: "生活场景",
    description: "Natural light, real-world scene, human interaction.",
    descriptionZh: "自然光、真实场景、人物互动。",
    keywords: ["natural", "lifestyle", "warm", "authentic"],
    promptGuidance:
      "Lifestyle photography style. Natural ambient lighting, real-world environment setting, warm and inviting tones, authentic human interaction with the main subject, shallow depth of field, editorial quality composition.",
    coverImage: "/preset-covers/lifestyle.png",
    previewTone: "rose",
    defaults: { aspectRatio: "4:3", count: 1 },
  },
  {
    id: "flat-lay",
    category: "photography",
    name: "Flat Lay",
    nameZh: "平铺摄影",
    description: "Top-down view, organized arrangement, minimal composition.",
    descriptionZh: "俯拍视角、有序排列、极简构图。",
    keywords: ["top-down", "organized", "minimal", "flat-lay"],
    promptGuidance:
      "Flat lay photography style. Directly overhead camera angle, carefully arranged objects on a clean surface, organized grid or artful scatter layout, soft even lighting with minimal shadows, cohesive color palette.",
    coverImage: "/preset-covers/flat-lay.png",
    previewTone: "mint",
    defaults: { aspectRatio: "1:1", count: 1 },
  },
  // ── Illustration ──
  {
    id: "flat-illustration",
    category: "illustration",
    name: "Flat Illustration",
    nameZh: "扁平插画",
    description: "Vector style, geometric shapes, vibrant colors.",
    descriptionZh: "矢量风、几何形状、鲜明配色。",
    keywords: ["vector", "geometric", "flat", "vibrant"],
    promptGuidance:
      "Flat vector illustration style. Clean geometric shapes, bold vibrant color palette, minimal gradients, no realistic textures, simple stylized characters and objects, modern graphic design aesthetic.",
    coverImage: "/preset-covers/flat-illustration.png",
    previewTone: "sky",
    defaults: { aspectRatio: "1:1", count: 1 },
  },
  {
    id: "watercolor",
    category: "illustration",
    name: "Watercolor",
    nameZh: "水彩风",
    description: "Hand-painted feel, soft gradients, artistic texture.",
    descriptionZh: "手绘质感、柔和渐变、艺术感。",
    keywords: ["watercolor", "hand-painted", "soft", "artistic"],
    promptGuidance:
      "Watercolor illustration style. Visible brush strokes and paint textures, soft color bleeding and gradients, slightly imperfect organic edges, muted yet warm color palette, artistic and delicate atmosphere.",
    coverImage: "/preset-covers/watercolor.png",
    previewTone: "lavender",
    defaults: { aspectRatio: "3:4", count: 1 },
  },
  // ── UI Design ──
  {
    id: "minimal-ui",
    category: "ui-design",
    name: "Minimal UI",
    nameZh: "极简 UI",
    description: "Clean whitespace, monochrome palette, thin lines, web-standard.",
    descriptionZh: "大留白、单色系、细线条、Web 规范。",
    keywords: ["whitespace", "monochrome", "clean", "functional"],
    promptGuidance:
      "Minimal UI design style. Large whitespace, monochrome or very limited color palette with one accent color, thin hairline borders, Inter or system sans-serif typography, functional layout following web conventions, 8px spacing grid.",
    coverImage: "/preset-covers/minimal.png",
    previewTone: "sand",
    defaults: { aspectRatio: "16:9", count: 1 },
  },
  {
    id: "glass-ui",
    category: "ui-design",
    name: "Glass UI",
    nameZh: "玻璃态 UI",
    description: "Frosted glass layers, gradient micro-glow, translucent depth.",
    descriptionZh: "毛玻璃层叠、暗底、渐变微光。",
    keywords: ["frosted", "translucent", "glow", "gradient"],
    promptGuidance:
      "Glassmorphism UI design style. Dark background with frosted glass translucent panels, subtle gradient glows and light refraction effects, layered depth with backdrop blur, soft rounded corners, muted neon accent colors.",
    coverImage: "/preset-covers/glass.png",
    previewTone: "sky",
    defaults: { aspectRatio: "16:9", count: 1 },
  },
  {
    id: "dark-luxury-ui",
    category: "ui-design",
    name: "Dark Luxury",
    nameZh: "暗黑奢华",
    description: "Deep dark base, metallic accents, refined elegance.",
    descriptionZh: "深色、金属质感、精致细节。",
    keywords: ["dark", "metallic", "elegant", "premium"],
    promptGuidance:
      "Dark luxury UI design style. Deep black or charcoal background, gold or silver metallic accent elements, refined typography with generous letter-spacing, subtle micro-light details, premium and exclusive atmosphere.",
    coverImage: "/preset-covers/dark-luxury.png",
    previewTone: "lavender",
    defaults: { aspectRatio: "16:9", count: 1 },
  },
  // ── 3D Render ──
  {
    id: "object-3d",
    category: "3d-render",
    name: "3D Render",
    nameZh: "3D 渲染",
    description: "Three-dimensional render, light and shadow, industrial design.",
    descriptionZh: "三维渲染、光影质感、工业设计。",
    keywords: ["3d", "render", "industrial", "object"],
    promptGuidance:
      "3D object rendering style. Realistic three-dimensional modeling, studio HDRI lighting with reflections and refractions, smooth material surfaces, subtle environment reflections, industrial design precision, isometric or hero angle perspective.",
    coverImage: "/preset-covers/object-3d.png",
    previewTone: "sage",
    defaults: { aspectRatio: "1:1", count: 1 },
  },
  // ── Social / Marketing ──
  {
    id: "social-launch",
    category: "social",
    name: "Launch Poster",
    nameZh: "发布海报",
    description: "Launch-day hero visual with clear hierarchy.",
    descriptionZh: "项目发布日主视觉，层次清晰、视觉冲击。",
    keywords: ["launch", "hero", "announcement"],
    promptGuidance:
      "Launch poster style. Visually striking hero composition, clear typographic hierarchy with bold headline and supporting text, modern gradient or solid background, screenshot or 3D mockup as focal point, launch-ready professional quality.",
    coverImage: "/preset-covers/social-launch.png",
    previewTone: "sky",
    defaults: {
      aspectRatio: "4:3",
      count: 1,
    },
  },
  {
    id: "social-og",
    category: "social",
    name: "OG / Share Card",
    nameZh: "分享卡片",
    description: "1200×630 social share image, concise and eye-catching.",
    descriptionZh: "社交分享图，1200×630，简洁醒目。",
    keywords: ["og-image", "social", "share", "card"],
    promptGuidance:
      "Social media OG image style. 1200×630 aspect ratio optimized, bold readable headline text, clean background with brand colors, minimal elements for fast visual parsing at small sizes, no fine details that get lost when thumbnailed.",
    coverImage: "/preset-covers/social-og.png",
    previewTone: "mint",
    defaults: {
      aspectRatio: "16:9",
      count: 1,
    },
  },
  {
    id: "social-banner",
    category: "social",
    name: "Web Banner",
    nameZh: "网页横幅",
    description: "Wide banner for web or newsletter header.",
    descriptionZh: "网页横幅或 Newsletter 头图。",
    keywords: ["banner", "newsletter", "header", "wide"],
    promptGuidance:
      "Web banner style. Ultra-wide horizontal composition, bold headline with CTA button area, gradient or photographic background, clean modern typography, optimized for web display at various widths.",
    coverImage: "/preset-covers/social-banner.png",
    previewTone: "rose",
    defaults: {
      aspectRatio: "16:9",
      count: 1,
    },
  },
  // ── Batch (multi-variant) ──
  {
    id: "batch-scene-variants",
    category: "batch",
    name: "Scene Variants",
    nameZh: "场景变体",
    description: "Upload a photo, get 4 high-quality scene variations.",
    descriptionZh: "上传一张图，一键生成 4 种不同场景的高质量变体。",
    keywords: ["scene", "variation", "batch", "consistent"],
    promptGuidance: "Generate photography variations in multiple scene settings, keeping the main subject consistent across all four.",
    coverImage: "/preset-covers/social-banner.png",
    previewTone: "sand",
    defaults: { aspectRatio: "1:1", count: 1 },
    batchVariants: [
      {
        key: "marble-table",
        label: "Marble Table",
        labelZh: "大理石台面",
        promptSuffix:
          "Place the main subject on a pristine white marble surface with subtle grey veining, soft diffused studio lighting from above, clean bright background, polished editorial quality, crisp sharp focus",
      },
      {
        key: "hand-held",
        label: "Hand Held",
        labelZh: "手持展示",
        promptSuffix:
          "An elegant hand gracefully holding the main subject, soft golden hour sunlight creating warm rim lighting, shallow depth of field with creamy bokeh background, refined editorial quality, shot on Canon EOS R5",
      },
      {
        key: "lifestyle",
        label: "Lifestyle",
        labelZh: "生活场景",
        promptSuffix:
          "The main subject in a curated lifestyle flat lay on a warm wooden surface, surrounded by dried flowers and natural linen fabric, overhead top-down perspective, soft natural window light, editorial magazine aesthetic",
      },
      {
        key: "dark-luxe",
        label: "Dark Luxe",
        labelZh: "暗黑奢华",
        promptSuffix:
          "The main subject on a deep black reflective surface, dramatic single-source side lighting creating strong highlights, subtle smoke or mist effect around the base, noir aesthetic, high contrast, premium editorial finish",
      },
    ],
  },
  {
    id: "batch-creative-set",
    category: "batch",
    name: "Creative Set",
    nameZh: "创作变体套图",
    description: "Subject-consistent 4-image set across different lighting and moods.",
    descriptionZh: "围绕同一主体，一次生成 4 张不同光影与情绪的图。",
    keywords: ["set", "variation", "subject-consistent", "batch"],
    promptGuidance:
      "Generate a creative 4-image set that keeps the main subject identity consistent while varying composition, lighting, mood, and environment across all four shots.",
    coverImage: "/preset-covers/lifestyle.png",
    previewTone: "sand",
    defaults: { aspectRatio: "1:1", count: 1 },
    batchVariants: [
      {
        key: "studio-clean",
        label: "Studio",
        labelZh: "棚拍",
        promptSuffix:
          "Clean studio composition, soft diffused key light, neutral seamless background, sharp focus on the main subject, editorial quality, no clutter",
      },
      {
        key: "golden-hour",
        label: "Golden Hour",
        labelZh: "金色时刻",
        promptSuffix:
          "Outdoor golden-hour ambience, warm rim lighting, shallow depth of field, creamy bokeh background, cinematic mood",
      },
      {
        key: "moody-noir",
        label: "Moody Noir",
        labelZh: "暗调",
        promptSuffix:
          "Low-key dramatic lighting, deep shadows, single directional light source, high contrast, noir / editorial aesthetic",
      },
      {
        key: "soft-natural",
        label: "Soft Natural",
        labelZh: "自然柔光",
        promptSuffix:
          "Soft natural window light, organic textures, warm muted palette, lifestyle editorial feel, gentle shallow depth",
      },
    ],
  },
  {
    id: "batch-style-transfer",
    category: "batch",
    name: "Style Transfer",
    nameZh: "风格迁移",
    description: "Upload any image, get 4 artistic style variations.",
    descriptionZh: "上传图片，一键生成 4 种艺术风格变体。",
    keywords: ["style", "transfer", "art", "batch"],
    promptGuidance: "Transform an image into multiple artistic styles.",
    coverImage: "/preset-covers/watercolor.png",
    previewTone: "lavender",
    defaults: { aspectRatio: "1:1", count: 1 },
    batchVariants: [
      {
        key: "hand-drawn",
        label: "Hand-drawn",
        labelZh: "手绘",
        promptSuffix:
          "Transform into a cute hand-drawn illustration style. Soft colored pencil and marker technique, slightly exaggerated cute proportions, warm pastel color palette, visible pencil strokes, whimsical children's book illustration quality",
      },
      {
        key: "oil-painting",
        label: "Oil Painting",
        labelZh: "油画",
        promptSuffix:
          "Transform into a classical oil painting. Rich impasto brushwork with visible thick paint texture, warm Rembrandt-style lighting with dramatic chiaroscuro, deep earthy tones, museum gallery quality, Dutch Golden Age style",
      },
      {
        key: "ink-wash",
        label: "Ink Wash",
        labelZh: "水墨画",
        promptSuffix:
          "Transform into traditional Chinese ink wash painting (水墨画). Elegant monochrome brushwork with varying ink density, flowing calligraphic brush strokes, strategic use of negative space, subtle red seal stamp in corner, rice paper texture",
      },
      {
        key: "abstract",
        label: "Abstract",
        labelZh: "抽象",
        promptSuffix:
          "Transform into bold abstract expressionist art. Geometric fragmentation with cubist influence, vibrant saturated colors — electric blue, hot pink, cadmium yellow, emerald green — energetic brushstrokes and drips, Kandinsky and Picasso inspired",
      },
    ],
  },
];

export const PRESET_CATEGORIES: { id: PresetCategory; label: string; labelZh: string }[] = [
  { id: "batch", label: "Batch", labelZh: "批量创作" },
  { id: "photography", label: "Photography", labelZh: "摄影" },
  { id: "illustration", label: "Illustration", labelZh: "插画" },
  { id: "ui-design", label: "UI Design", labelZh: "UI 设计" },
  { id: "3d-render", label: "3D Render", labelZh: "3D 渲染" },
  { id: "social", label: "Social", labelZh: "社交海报" },
];

export function findPresetById(id: string | null | undefined): StylePreset | null {
  if (!id) return null;
  return STYLE_PRESETS.find((p) => p.id === id) ?? null;
}

export function getPresetsByCategory(category: PresetCategory): StylePreset[] {
  return STYLE_PRESETS.filter((p) => p.category === category);
}
