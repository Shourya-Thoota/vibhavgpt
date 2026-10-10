// This is the single maintained source of truth for product-facing facts.
// Keep it in sync with billing, legal copy, and navigation whenever a product
// change ships. It is deliberately data-first so it can serve both the UI and
// the chat system prompt without duplicating facts in prose strings.

export const PRODUCT_KNOWLEDGE = Object.freeze({
  creator: "VibhavGPT was created by Vibhav Thoota and is operated by Pansophy LLC.",
  company: "VibhavGPT is operated by Pansophy LLC.",
  domain: "The official company domain is pansophy.com. Never refer to pansophy.tech or any other domain as Pansophy's official domain.",
  models: [
    ["Lumen", "lightweight and quick for simple, everyday tasks"],
    ["Nova", "fast, general-purpose help and a strong default"],
    ["Study", "learning, worked examples, and practice"],
    ["Nebula", "strong reasoning for demanding, high-complexity work"],
    ["Vesper", "the flagship with the highest reasoning capacity, built for the most difficult problems"],
  ],
  plans: [
    {
      id: "free",
      name: "Free",
      monthly: "$0",
      yearly: "$0",
      description: "A lightweight start for everyday questions.",
      features: [
        "1M tokens each for Lumen and Nova, 500K for Study per month",
        "Image and document generation requires Plus or Pro",
        "5 MB maximum document and image uploads",
      ],
      details: [
        "Free includes Lumen and Nova: 1M tokens per calendar month and 100K per rolling 5 hours each. Study: 500K per month and 50K per rolling 5 hours. Nebula and Vesper require Plus or Pro.",
        "Image and document generation requires Plus or Pro; Flex Credits do not unlock generation on Free.",
        "Document and image uploads are limited to 5 MB per file.",
      ],
    },
    {
      id: "plus",
      name: "Plus",
      monthly: "$4.99",
      yearly: "$49.99",
      description: "More room for regular work and creative projects.",
      features: [
        "8M tokens each for Lumen and Nova, 4M Study, 1.5M Nebula, 300K Vesper per month",
        "25 image + 20 document generations per billing month",
        "25 MB document and 10 MB image uploads",
      ],
      details: [
        "Plus costs $4.99 per month or $49.99 per year on the web.",
        "Plus monthly / rolling 5-hour token caps: Lumen and Nova each 8M / 800K; Study 4M / 400K; Nebula 1.5M / 150K; Vesper 300K / 30K.",
        "Input and output tokens both count. Monthly token caps reset on the first day at 00:00 UTC. The 5-hour window rolls continuously.",
        "Plus includes 25 image generations and 20 document generations per subscription billing month.",
        "Document uploads are limited to 25 MB per file and image uploads to 10 MB per file.",
      ],
    },
    {
      id: "pro",
      name: "Pro",
      monthly: "$12.99",
      yearly: "$129.99",
      description: "Higher token allowances and room for larger projects.",
      features: [
        "12M tokens each for Lumen and Nova, 6M Study, 3M Nebula, 800K Vesper per month",
        "60 image generations per UTC calendar month; unlimited document generations",
        "80 MB document and 20 MB image uploads",
      ],
      details: [
        "Pro costs $12.99 per month or $129.99 per year on the web.",
        "Pro monthly / rolling 5-hour token caps: Lumen and Nova each 12M / 1.2M; Study 6M / 600K; Nebula 3M / 300K; Vesper 800K / 80K.",
        "Input and output tokens both count. Monthly token caps reset on the first day at 00:00 UTC. The 5-hour window rolls continuously.",
        "Pro includes 60 image generations per UTC calendar month and unlimited document generations.",
        "Document uploads are limited to 80 MB per file and image uploads to 20 MB per file.",
      ],
    },
  ],
  refunds: "Refund eligibility and processing follow applicable law and the billing provider's refund process. Contact support@pansophy.com for assistance with billing questions.",
  support: "For help, email support@pansophy.com.",
  navigation: [
    ["theme or accent color", "Settings, then Appearance"],
    ["two-step verification, authenticator app, backup codes, passkeys, or password security", "Settings, then Security"],
    ["subscription, changing plans, payment method, invoices, or cancelling a plan", "the profile menu, then Plan and billing"],
    ["saved memories or importing memories", "Memory in the sidebar"],
    ["a new conversation", "New chat in the sidebar"],
    ["past conversations", "the conversation list in the sidebar"],
    ["projects, folders, or project instructions", "the Projects and Folders sections of the Chat or Study sidebar; a chat's menu has Move to"],
    ["the setup questions (name, background, units, sky and universe)", "Settings, then Personality, then Run setup again"],
    ["exporting account data", "Settings, then Your data"],
    ["the VibhavGPT Guarantee", "vibhavgpt.com/guarantee"],
  ],
  // The VibhavGPT Guarantee: VibhavGPT's own commitments, in the first
  // person, each a heading and a plain explanation. The Guarantee page
  // renders these; the Terms and Privacy Policy refer to them; the assistant
  // answers from them. They speak only for VibhavGPT.
  guarantee: [
    ["We never train on your chats", "Your conversations, files, images and memories are here to answer you. We never use them to train AI models."],
    ["We never sell your data", "We never sell, rent or trade your personal data or your content, to advertisers, data brokers or anyone else."],
    ["We never show ads", "VibhavGPT is paid for by subscriptions and Flex Credits. You will never see ads, sponsored answers or ad tracking."],
    ["You can export or delete everything, any time", "Download a copy of your account, conversations, projects, memory and usage records from Settings, then Your data. Delete your account from Settings, or on the web at vibhavgpt.com/account-deletion, without contacting anyone."],
  ],
  terms: [
    ["Who we are", "VibhavGPT is operated by Pansophy LLC (\u201cPansophy,\u201d \u201cwe,\u201d or \u201cus\u201d). By creating an account or using VibhavGPT, you agree to these Terms."],
    ["Eligibility", "You must be at least 16 years old to use VibhavGPT. By creating an account, you confirm that you meet this requirement."],
    ["The service", "VibhavGPT provides chat, persistent memory, web search, study tools, projects and folders for organizing conversations (with optional project instructions), image creation with shape and style choices, document creation, and file and image reading through Free, Plus, and Pro tiers. Plan allowances and limits are shown on the Pricing page and in your account."],
    ["The VibhavGPT Guarantee", "The commitments in the VibhavGPT Guarantee at vibhavgpt.com/guarantee are part of these Terms: we never train on your chats, we never sell your data, we never show ads, and you can export your data or delete your account at any time."],
    ["Subscriptions and cancellation", "Subscriptions are billed monthly or annually through our payment processor; the current checkout creates a 7-day trial. Subscriptions renew unless canceled. Cancel a subscription in Plan and billing. Access generally continues through the paid period."],
    ["Refunds", "Refund eligibility and processing follow applicable law and the billing provider's refund process. Contact support@pansophy.com for assistance with billing questions."],
    ["Flex Credits", "Flex Credits are optional, purchased separately on the web, and do not renew as a subscription. Credit balances do not expire. Chat and Study token caps apply even when you have Flex Credits. On Plus or Pro, image generations beyond the included allowance use 3 credits each and document generations beyond the included allowance use 1 credit each. Flex Credits do not unlock image or document generation on Free. Credits reserved for a request are returned when that request fails."],
    ["Acceptable use", "Do not use VibhavGPT unlawfully, abuse or circumvent limits, resell access, or generate harmful, abusive, or illegal content."],
    ["Your content", "You retain ownership of content you send. You grant Pansophy permission to process it to provide and protect the service, including responses, memory, file analysis, and image and document generation, as described in the Privacy Policy. Requests are processed by the AI and service providers needed for the feature, as described in the Privacy Policy. Project instructions and setup answers you give are treated as your content."],
    ["Disclaimers and liability", "AI responses may be inaccurate or inappropriate and should not be relied on for medical, legal, financial, or safety-critical decisions. To the fullest extent permitted by law, Pansophy LLC is not liable for indirect, incidental, or consequential damages."],
    ["Changes", "We may modify the service or these Terms. Continued use after changes constitutes acceptance."],
    ["Governing law", "The Terms are governed by the laws of the State of New York."],
    ["Contact", "Questions can be sent to support@pansophy.com."],
  ],
  privacy: [
    ["Information we collect", "We collect account details such as your email and user identifier; chat messages and responses; durable memory facts; uploaded files and images; image-generation prompts, chosen shapes and styles, and results; custom image and folder names; project and folder names, project instructions, and which conversations you file in them; usage and app-activity records; subscription and purchase status; and security and diagnostic records needed to operate and protect your account. Your setup answers are stored on your device, and the parts that shape replies (the name you want to be called, how much background to assume, units, and reply style) are saved to your account as personal instructions you can edit in Settings."],
    ["How we use information", "We use information to provide requested features, authenticate your account, enforce plan and credit limits, manage subscriptions and purchases, personalize responses through memory, personal instructions and project instructions, answer requested searches, prevent abuse, and maintain security and reliability. We never train on your chats, we never sell your personal data, and we never show advertising or use your data for ad targeting."],
    ["The VibhavGPT Guarantee", "This policy is written to keep the VibhavGPT Guarantee at vibhavgpt.com/guarantee: we never train on your chats, we never sell your data, we never show ads, and you can export your data or delete your account at any time."],
    ["AI, hosting, and service providers", "We use service providers in these categories to run VibhavGPT: AI inference providers, which process your messages and other content to generate responses and provide the features you request, including requested web searches; hosting and database providers, which store the application database and your uploads; email delivery, for account and security email; error monitoring, which receives error and diagnostic data; and payment processing, which handles billing. Payment-card details are handled by the payment processor, and Pansophy never sees your full card number."],
    ["Retention and deletion", "Requests are sent over encrypted HTTPS/TLS connections where supported by the service. You can delete conversations, projects, folders and memory facts in the app (deleting a project or folder keeps its conversations), turn memory off, export your account data, delete your account in Settings, or request deletion on the web at https://vibhavgpt.com/account-deletion without reinstalling the app. After a verified request, associated account data is removed from active VibhavGPT systems. Restricted disaster-recovery backups expire through scheduled rotation within 12 months. Billing, payment, security, and provider records may be retained under the relevant provider's policies or legal obligations. Account deletion is blocked while a web subscription is active; cancel it in Plan and billing first."],
    ["Children's privacy", "VibhavGPT is not intended for anyone under 16, and we do not knowingly collect information from children under 16."],
    ["Security and changes", "We use industry-standard safeguards and encrypted connections, but no system is completely secure. We may update this policy periodically."],
    ["Contact", "Privacy questions can be sent to support@pansophy.com."],
  ],
  credits: "Flex Credits can be purchased on the web for $1 to $500 in $0.10 increments; $1 buys 100 credits. Credits do not expire. Chat and Study token caps apply even when you have Flex Credits. On Plus or Pro, image generations beyond the included allowance cost 3 credits each and document generations beyond the included allowance cost 1 credit each; Free cannot use Flex Credits to unlock image or document generation. Unused reservations are refunded when the request fails.",
  thinkingEffort: "Paid plans provide thinking-effort controls for Nova, Nebula, and Vesper. Higher effort may consume more output tokens. Study uses low-cost reasoning settings. All chat and Study usage is measured in input plus output tokens.",
});

export function buildProductKnowledgeAddendum(question) {
  const text = String(question ?? "").toLowerCase();
  const asksAboutPlans = /\b(price|pricing|cost|plan|plans|tier|tiers|subscription|billing|upgrade|downgrade)\b/.test(text);
  const asksAboutIdentity = /\b(who (made|created|built|developed) (you|vibhavgpt)|who are you|what are you|what do you do|about yourself|about vibhavgpt|what is vibhavgpt|creator|founder)\b/.test(text);
  const refersToProduct = /\b(vibhavgpt|lumen|nova|study|nebula|vesper|free|plus|pro|our app|our service)\b/.test(text);
  if (asksAboutIdentity) {
    return [
      "**VibhavGPT identity**",
      PRODUCT_KNOWLEDGE.creator,
      "Answer identity questions directly and concretely. Do not substitute an underlying provider or model-family name for VibhavGPT.",
      "VibhavGPT assistants: Lumen, Nova, Study, Nebula, and Vesper.",
    ].join("\n");
  }
  if (!refersToProduct) return "";
  if (asksAboutPlans) {
    return [
      "**Official VibhavGPT plan details**",
      ...PRODUCT_KNOWLEDGE.plans.map((plan) => `- **${plan.name}: ${plan.id === "free" ? plan.monthly : `${plan.monthly}/month or ${plan.yearly}/year`} on the web:** ${plan.details.join(" ")}`),
    ].join("\n");
  }
  const context = ["**VibhavGPT product information**", PRODUCT_KNOWLEDGE.creator, PRODUCT_KNOWLEDGE.company];
  if (/\b(refund|cancel|cancellation|trial|billing|renew|subscription|payment)\b/.test(text)) {
    context.push(...modelSafeTermsRows().filter(([heading]) => /subscriptions|refunds/i.test(heading)).map(([heading, body]) => `- ${heading}: ${body}`));
  } else if (/\b(privacy|data|delete|retention|collect|train|training|ads?|sell|guarantee|export)\b/.test(text)) {
    context.push("The VibhavGPT Guarantee:\n" + PRODUCT_KNOWLEDGE.guarantee.map(([heading, body]) => `- ${heading}: ${body}`).join("\n"));
    context.push(...modelSafePrivacyRows().map(([heading, body]) => `- ${heading}: ${body}`));
  } else if (/\b(setting|where|find|manage|navigation|account)\b/.test(text)) {
    context.push("Navigation:\n" + PRODUCT_KNOWLEDGE.navigation.map(([item, destination]) => `- ${item}: ${destination}`).join("\n"));
  } else if (/\b(model|feature|capability|what is|about|workspace)\b/.test(text)) {
    context.push("Models:\n" + PRODUCT_KNOWLEDGE.models.map(([name, description]) => `- ${name}: ${description}`).join("\n"));
  }
  return context.join("\n");
}

function bulletList(rows) {
  return rows
    .map(([label, value, details]) => `- ${label}: ${value}${details ? `. ${details}` : ""}`)
    .join("\n");
}

// The legal text names service categories, never vendors, so the model
// reads it as written.
function modelSafeTermsRows() {
  return PRODUCT_KNOWLEDGE.terms;
}

function modelSafePrivacyRows() {
  return PRODUCT_KNOWLEDGE.privacy;
}

export function buildProductKnowledgeSystemPrompt() {
  const product = PRODUCT_KNOWLEDGE;
  return [
    "<vibhavgpt-product-knowledge>",
    "The following product facts are authoritative. When asked about VibhavGPT, pricing, billing, policies, support, product capabilities, or where a setting lives, answer from these facts. For a plan-comparison or pricing question, state each relevant plan's exact price and the listed model access and limits; do not replace those details with a vague summary. Do not invent product details, prices, policies, or navigation. If a requested product detail is absent, say you do not have that detail and direct the user to support@pansophy.com.",
    `Identity: ${product.creator} If asked who made or created you, answer that directly before describing your current assistant name. If asked what you know about the user, use only explicit conversation or supplied memory facts and say when none are available; never guess.`,
    product.company,
    product.domain,
    "Models:\n" + bulletList(product.models),
    "Plans and pricing:\n" + product.plans.map((plan) => `- ${plan.name}: web ${plan.id === "free" ? "$0" : `${plan.monthly}/month or ${plan.yearly}/year`}. ${plan.details.join(" ")}`).join("\n"),
    "Mandatory pricing-answer rule: For a plan question, state the correct web price and the complete listed access and limits for each plan asked about: monthly and rolling 5-hour token caps, image and document generations, and upload sizes. Monthly token caps reset on the first day at 00:00 UTC. Do not describe Pro model or image limits as unlimited unless the matching plan detail explicitly says so.",
    "Flex Credits are purchased on the web only.",
    "Do not say that any upload, message, model-access, price, or billing detail is undocumented when it appears in the Plans and pricing list above. Those entries are the current released facts and must be repeated accurately when requested.",
    `Refund policy: ${product.refunds}`,
    `Support: ${product.support}`,
    "Navigation:\n" + bulletList(product.navigation),
    "The VibhavGPT Guarantee:\n" + bulletList(product.guarantee),
    "Terms of Service summary:\n" + bulletList(modelSafeTermsRows()),
    "Privacy Policy summary:\n" + bulletList(modelSafePrivacyRows()),
    `Credits: ${product.credits}`,
    `Thinking effort: ${product.thinkingEffort}`,
    "Non-negotiable pricing output constraint: For any pricing, plan, billing, or model-access question, include every relevant complete plan fact line verbatim. Do not abbreviate, summarize, or replace a number with a vague label:\n" + product.plans.map((plan) => `- ${plan.name} (${plan.id === "free" ? "$0" : `${plan.monthly}/month or ${plan.yearly}/year`} on the web): ${plan.details.join(" ")}`).join("\n"),
    "</vibhavgpt-product-knowledge>",
  ].join("\n");
}
