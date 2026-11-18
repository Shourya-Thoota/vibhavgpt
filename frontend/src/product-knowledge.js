// This is the single maintained source of truth for product-facing facts.
// Keep it in sync with billing, legal copy, and navigation whenever a product
// change ships. It is deliberately data-first so it can serve both the UI and
// the chat system prompt without duplicating facts in prose strings.

import { normalizeCarryMode } from "./credits-policy.js";
import { creditsKnowledgeOverrides, creditsPricingRule } from "./credits-copy.js";
import { IMAGES_PER_MONTH, countText } from "./plan-entitlements.js";
import { THIRD_PARTY_BILLING_NOTE } from "./model-marketplace.js";

export const PRODUCT_KNOWLEDGE = Object.freeze({
  creator: "VibhavGPT was created by Vibhav Thoota and is operated by Pansophy LLC.",
  company: "VibhavGPT is operated by Pansophy LLC.",
  domain: "The official company domain is pansophy.com. Never refer to pansophy.tech or any other domain as Pansophy's official domain.",
  models: [
    ["Lumen", "lightweight and quick for simple, everyday tasks"],
    ["Study", "learning, worked examples, and practice"],
    ["Vulcan", "top-tier reasoning, built for difficult problems"],
    ["Zenith", "the flagship and most capable model, built for the hardest problems"],
    ["Tecton", "the coding model in Build, made for prototypes, on Pro and Max"],
    ["Prism", "the image model, for pictures made from a description"],
    ["Aura", "a second image model you can choose in Image mode, for another look at the same description"],
  ],
  plans: [
    {
      id: "free",
      name: "Free",
      monthly: "$0",
      yearly: "$0",
      description: "A lightweight start for everyday questions.",
      features: [
        "Up to 15 AI requests in any 24-hour period, subject to a shared $0.25 included allowance each UTC calendar month for Lumen and Study. One message or action can use more than one AI request",
        "2 image generations per week; document generation requires Plus or Pro",
        "5 MB maximum document and image uploads",
        "Search past chats; choose when memory is used",
      ],
      details: [
        "Free includes Lumen and Study. A Free account can use up to 15 AI requests in any 24-hour period, subject to a shared $0.25 allowance each UTC calendar month. One message or action can use more than one AI request. Vulcan requires Pro, and Zenith requires Max.",
        "Free includes 2 image generations per week, counted in a fixed week that starts on Monday at 00:00 UTC. Each is one plain image, without reference photos or several at once. Document generation requires Plus or Pro; image & document credits do not add images or unlock documents on Free.",
        "Document and image uploads are limited to 5 MB per file.",
        "Every plan can search its past chats, turn memory off or delete what it has saved, and add an optional location for local answers.",
        "Images made on Free carry a small black-and-white VibhavGPT watermark in the bottom-right corner, on screen and in downloads; it cannot be turned off on Free.",
      ],
    },
    {
      id: "plus",
      name: "Plus",
      monthly: "$4.99",
      yearly: "$49.99",
      description: "More room for regular work and creative projects.",
      features: [
        "8M tokens for Lumen, 4M Study per month",
        "100 image + 20 document generations per billing month",
        "25 MB document and 10 MB image uploads",
        "A Library of what you make, and saved reference photos for images",
      ],
      details: [
        "Plus costs $4.99 per month or $49.99 per year on the web.",
        "Plus monthly / rolling 5-hour token caps: Lumen 8M / 800K; Study 4M / 400K. Vulcan is on Pro.",
        "Input and output tokens both count. Monthly token caps reset on the first day at 00:00 UTC. The 5-hour window rolls continuously.",
        "Plus includes 100 image generations and 20 document generations per subscription billing month.",
        "Document uploads are limited to 25 MB per file and image uploads to 10 MB per file.",
        "Plus includes a Library of the documents and images you make, and up to 10 saved reference photos for images.",
        "The VibhavGPT image watermark is optional on Plus and off by default; it can be turned on in Settings > Media.",
      ],
    },
    {
      id: "pro",
      name: "Pro",
      monthly: "$12.99",
      yearly: "$129.99",
      description: "Higher token allowances and room for larger projects.",
      features: [
        "12M tokens for Lumen, 6M Study, 800K Vulcan per month",
        "400 image generations per UTC calendar month; unlimited document generations",
        "80 MB document and 20 MB image uploads",
        "A Library of what you make, and saved reference photos for images",
      ],
      details: [
        "Pro costs $12.99 per month or $129.99 per year on the web.",
        "Pro monthly / rolling 5-hour token caps: Lumen 12M / 1.2M; Study 6M / 600K; Vulcan 800K / 80K.",
        "Input and output tokens both count. Monthly token caps reset on the first day at 00:00 UTC. The 5-hour window rolls continuously.",
        "Pro includes 400 image generations per UTC calendar month and unlimited document generations.",
        "Document uploads are limited to 80 MB per file and image uploads to 20 MB per file.",
        "Pro includes a Library of the documents and images you make, and up to 10 saved reference photos for images.",
        "The VibhavGPT image watermark is optional on Pro and off by default; it can be turned on in Settings > Media.",
      ],
    },
    {
      id: "max",
      name: "Max",
      monthly: "$49.99",
      yearly: "$499.90",
      description: "Highest capacity for high-volume work and larger projects.",
      features: [
        "Highest monthly usage allowance across advanced models",
        "Full access to advanced models and reasoning capabilities",
        "Zenith, the flagship model, is included only with Max",
        `${countText(IMAGES_PER_MONTH.max)} image generations per month; unlimited document generations`,
        "80 MB document and 20 MB image uploads",
      ],
      details: [
        "Max costs $49.99 per month or $499.90 per year on the web.",
        "Max monthly / rolling 5-hour token caps: Lumen 30M / 3M; Study 15M / 1.5M; Vulcan 2M / 200K.",
        "Input and output tokens both count. Monthly token caps reset on the first day at 00:00 UTC. The 5-hour window rolls continuously.",
        `Max includes ${countText(IMAGES_PER_MONTH.max)} image generations per month and unlimited document generations.`,
        "Document uploads are limited to 80 MB per file and image uploads to 20 MB per file.",
        "The VibhavGPT image watermark is optional on Max and off by default; it can be turned on in Settings > Media.",
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
    ["projects or project instructions", "the Projects section of the sidebar; a chat's menu has Move to"],
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
    ["We never show ads", "VibhavGPT is paid for by subscriptions and image & document credits. You will never see ads, sponsored answers or ad tracking."],
    ["You can export or delete everything, any time", "Download a copy of your account, conversations, projects, memory and usage records from Settings, then Your data. Delete your account from Settings, or on the web at vibhavgpt.com/account-deletion, without contacting anyone."],
  ],
  terms: [
    ["Who we are", "VibhavGPT is operated by Pansophy LLC (\u201cPansophy,\u201d \u201cwe,\u201d or \u201cus\u201d). By creating an account or using VibhavGPT, you agree to these Terms."],
    ["Eligibility", "You must be at least 16 years old to use VibhavGPT. Before an account can be used, we ask for your month and year of birth and for you to accept these Terms and the Privacy Policy; we record that you accepted and whether you are 16 or older, and an account under 16 is blocked."],
    ["The service", "VibhavGPT provides chat, persistent memory, web search, study tools, projects for organizing conversations (with optional project instructions), image creation with shape and style choices, document creation, and file and image reading through Free, Plus, and Pro tiers. Plan allowances and limits are shown on the Pricing page and in your account."],
    ["The VibhavGPT Guarantee", "The commitments in the VibhavGPT Guarantee at vibhavgpt.com/guarantee are part of these Terms: we never train on your chats, we never sell your data, we never show ads, and you can export your data or delete your account at any time."],
    ["Subscriptions and cancellation", "Subscriptions are billed monthly or annually through our payment processor; the current checkout creates a 7-day trial. Subscriptions renew unless canceled. Cancel a subscription in Plan and billing. Access generally continues through the paid period."],
    ["Refunds", "Refund eligibility and processing follow applicable law and the billing provider's refund process. Contact support@pansophy.com for assistance with billing questions."],
    ["Image & document credits", "Image & document credits (previously called Flex Credits) are optional, bought on the web in one payment, and do not renew as a subscription. $1 buys 100 credits, and they do not expire. They pay for documents beyond a plan's included number: on Plus, each document after the 20 a month uses 1 credit. They do not add Chat or Study usage, and images cannot be bought beyond a plan's image allowance. Credits held for a request are returned when that request fails. Chat and Study token caps apply whatever your balance."],
    // The marketplace's billing disclosure, word for word as on Pricing (the model picker no longer repeats it).
    ["Third-party models", `${THIRD_PARTY_BILLING_NOTE} They are shown under their makers' own names, and each is available from the plan the model picker shows for it.`],
    ["Acceptable use", "Do not use VibhavGPT unlawfully, abuse or circumvent limits, resell access, or generate harmful, abusive, or illegal content."],
    ["Your content", "You retain ownership of content you send. You grant Pansophy permission to process it to provide and protect the service, including responses, memory, file analysis, and image and document generation, as described in the Privacy Policy. Requests are processed by the AI and service providers needed for the feature, as described in the Privacy Policy. Project instructions and setup answers you give are treated as your content."],
    ["Disclaimers and liability", "AI responses may be inaccurate or inappropriate and should not be relied on for medical, legal, financial, or safety-critical decisions. To the fullest extent permitted by law, Pansophy LLC is not liable for indirect, incidental, or consequential damages."],
    ["Changes", "We may modify the service or these Terms. Continued use after changes constitutes acceptance."],
    ["Copyright and takedown requests", "We respect copyright and respond to notices of claimed infringement under the U.S. Digital Millennium Copyright Act. If you believe content stored or shared through VibhavGPT (including uploads, profile pictures and saved avatars) infringes your copyright, send a notice to support@pansophy.com with: your physical or electronic signature; the work you say is infringed; the material you say infringes and where it is; your contact details; a statement that you believe in good faith the use is not authorized by the owner, its agent or the law; and a statement, under penalty of perjury, that the notice is accurate and that you are the owner or authorized to act for the owner. We remove or disable access to material that a valid notice identifies and tell the person who posted it, who may send a counter-notice with the details the law requires. We close the accounts of repeat infringers in appropriate circumstances."],
    ["Governing law", "The Terms are governed by the laws of the State of New York."],
    ["Contact", "Questions can be sent to support@pansophy.com."],
  ],
  privacy: [
    ["Information we collect", "We collect account details such as your email and user identifier; when you accepted the Terms and Privacy Policy, and the result of the age check (not your date of birth); chat messages and responses; durable memory facts; uploaded files and images; image-generation prompts, chosen shapes and styles, and results; custom image and folder names; project names, project instructions, and which conversations you file in them; usage and app-activity records; subscription and purchase status; and security and diagnostic records needed to operate and protect your account. Your setup answers are stored on your device, and the parts that shape replies (the name you want to be called, how much background to assume, units, and reply style) are saved to your account as personal instructions you can edit in Settings."],
    ["How we use information", "We use information to provide requested features, authenticate your account, enforce plan and credit limits, manage subscriptions and purchases, personalize responses through memory, personal instructions and project instructions, answer requested searches, prevent abuse, and maintain security and reliability. When you sign in with a third-party provider, that provider and VibhavGPT exchange your basic account details (your name and email) to authenticate you; your chats and usage data are never shared with sign-in providers. We never train on your chats, we never sell your personal data, and we never show advertising or use your data for ad targeting."],
    ["The VibhavGPT Guarantee", "This policy is written to keep the VibhavGPT Guarantee at vibhavgpt.com/guarantee: we never train on your chats, we never sell your data, we never show ads, and you can export your data or delete your account at any time."],
    ["AI, hosting, and service providers", "We use service providers in these categories to run VibhavGPT: AI inference providers, which process your messages and other content to generate responses and provide the features you request, including requested web searches; hosting and database providers, which store the application database and your uploads; email delivery, for account and security email; error monitoring, which receives error and diagnostic data; and payment processing, which handles billing. Payment-card details are handled by the payment processor, and Pansophy never sees your full card number. If you speak a message with the microphone button, your device or browser turns your speech into text with its own built-in speech recognition, which may be processed by the company that makes your browser or phone under its own privacy policy; VibhavGPT never receives the audio, only the text you choose to send. The Writing Tools in Study (the AI Detector and the AI Humanizer) are provided by Clever AI and run in a window served by Clever AI: text you enter in them goes directly to Clever AI, is processed under Clever AI's own data policies, and is not saved with your VibhavGPT conversations or chat history."],
    ["Retention and deletion", "Requests are sent over encrypted HTTPS/TLS connections where supported by the service. You can delete conversations, projects and memory facts in the app (deleting a project keeps its conversations, and permanently deletes that project's memories), turn memory off, export your account data, delete your account in Settings, or request deletion on the web at https://vibhavgpt.com/account-deletion without reinstalling the app. Temporary chats are never saved to your chat list and are deleted within 24 hours. Requests on every plan are processed by third-party model infrastructure that may keep prompt data for a limited period, and never to train AI models. If you choose VibhavGPT Aura in Image mode (VibhavGPT Prism is the default), Aura's image provider may keep your prompt and any reference images for up to 30 days and receives a pseudonymous account identifier, never your name or email; it does not use them to train AI models. After a verified request, associated account data is removed from active VibhavGPT systems. Restricted disaster-recovery backups expire through scheduled rotation within 12 months. Billing, payment, security, and provider records may be retained under the relevant provider's policies or legal obligations. Account deletion is blocked while a web subscription is active; cancel it in Plan and billing first."],
    ["Children's privacy", "VibhavGPT is not intended for anyone under 16, and we do not knowingly collect information from children under 16. Every account is asked its month and year of birth before it can be used; we use it once to check age and keep only the result (16 or older, or not), never the date itself. An account under 16 is blocked, and can be deleted at vibhavgpt.com/account-deletion or by writing to support@pansophy.com."],
    ["Security and changes", "We use industry-standard safeguards and encrypted connections, but no system is completely secure. We may update this policy periodically."],
    ["Contact", "Privacy questions can be sent to support@pansophy.com."],
  ],
  credits: "Image & document credits (previously called Flex Credits) can be bought on the web for $1 to $500 in $0.10 steps; $1 buys 100 credits, and they do not expire. On Plus, each document beyond the 20 a month uses 1 credit. They do not add Chat or Study usage, and images cannot be bought beyond a plan's image allowance. Pro and Max have unlimited documents and Free has none, so there is nothing for credits to pay for on those plans. Credits held for a request are returned when it fails.",
  thinkingEffort: "Pro provides thinking-effort controls for Vulcan, and Max for Vulcan and Zenith. Higher effort may consume more output tokens. Study uses low-cost reasoning settings. All chat and Study usage is measured in input plus output tokens.",
});

// The product facts for a credits mode ("expiry" or "carry"), or the existing
// facts when there is none. Only the allowance wording differs; prices, models,
// uploads, legal and privacy text are the same objects.
const knowledgeVariants = new Map();
export function productKnowledgeFor(creditsMode = null) {
  const mode = normalizeCarryMode(creditsMode);
  if (!mode) return PRODUCT_KNOWLEDGE;
  if (!knowledgeVariants.has(mode)) {
    knowledgeVariants.set(mode, Object.freeze({ ...PRODUCT_KNOWLEDGE, ...creditsKnowledgeOverrides(PRODUCT_KNOWLEDGE, mode) }));
  }
  return knowledgeVariants.get(mode);
}

// Max is described but not offered as purchasable until its checkout is
// configured on the server; callers pass { maxAvailable } from that check.
function planPrice(plan) {
  if (plan.id === "free") return plan.monthly;
  return plan.yearly ? `${plan.monthly}/month or ${plan.yearly}/year` : `${plan.monthly}/month (monthly billing only)`;
}

function planDetails(plan, { maxAvailable = true } = {}) {
  if (plan.id === "max" && !maxAvailable) return [...plan.details, "Max is not available to purchase yet."];
  return plan.details;
}

export function buildProductKnowledgeAddendum(question, options = {}) {
  const product = productKnowledgeFor(options.creditsMode);
  const text = String(question ?? "").toLowerCase();
  const asksAboutPlans = /\b(price|pricing|cost|plan|plans|tier|tiers|subscription|billing|upgrade|downgrade)\b/.test(text);
  const asksAboutIdentity = /\b(who (made|created|built|developed) (you|vibhavgpt)|who are you|what are you|what do you do|about yourself|about vibhavgpt|what is vibhavgpt|creator|founder)\b/.test(text);
  const refersToProduct = /\b(vibhavgpt|lumen|nova|study|nebula|vesper|free|plus|pro|our app|our service)\b/.test(text);
  if (asksAboutIdentity) {
    return [
      "**VibhavGPT identity**",
      product.creator,
      "Answer identity questions directly and concretely. Do not substitute an underlying provider or model-family name for VibhavGPT.",
      "VibhavGPT assistants: Lumen, Study, Vulcan, and Zenith.",
    ].join("\n");
  }
  if (!refersToProduct) return "";
  if (asksAboutPlans) {
    return [
      "**Official VibhavGPT plan details**",
      ...product.plans.map((plan) => `- **${plan.name}: ${planPrice(plan)} on the web:** ${planDetails(plan, options).join(" ")}`),
    ].join("\n");
  }
  const context = ["**VibhavGPT product information**", product.creator, product.company];
  if (/\b(refund|cancel|cancellation|trial|billing|renew|subscription|payment)\b/.test(text)) {
    context.push(...modelSafeTermsRows(product).filter(([heading]) => /subscriptions|refunds/i.test(heading)).map(([heading, body]) => `- ${heading}: ${body}`));
  } else if (/\b(privacy|data|delete|retention|collect|train|training|ads?|sell|guarantee|export)\b/.test(text)) {
    context.push("The VibhavGPT Guarantee:\n" + product.guarantee.map(([heading, body]) => `- ${heading}: ${body}`).join("\n"));
    context.push(...modelSafePrivacyRows(product).map(([heading, body]) => `- ${heading}: ${body}`));
  } else if (/\b(setting|where|find|manage|navigation|account)\b/.test(text)) {
    context.push("Navigation:\n" + product.navigation.map(([item, destination]) => `- ${item}: ${destination}`).join("\n"));
  } else if (/\b(model|feature|capability|what is|about|workspace)\b/.test(text)) {
    context.push("Models:\n" + product.models.map(([name, description]) => `- ${name}: ${description}`).join("\n"));
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
function modelSafeTermsRows(product = PRODUCT_KNOWLEDGE) {
  return product.terms;
}

function modelSafePrivacyRows(product = PRODUCT_KNOWLEDGE) {
  return product.privacy;
}

export function buildProductKnowledgeSystemPrompt(options = {}) {
  const product = productKnowledgeFor(options.creditsMode);
  const creditsMode = normalizeCarryMode(options.creditsMode);
  return [
    "<vibhavgpt-product-knowledge>",
    "The following product facts are authoritative. When asked about VibhavGPT, pricing, billing, policies, support, product capabilities, or where a setting lives, answer from these facts. For a plan-comparison or pricing question, state each relevant plan's exact price and the listed model access and limits; do not replace those details with a vague summary. Do not invent product details, prices, policies, or navigation. If a requested product detail is absent, say you do not have that detail and direct the user to support@pansophy.com.",
    `Identity: ${product.creator} If asked who made or created you, answer that directly before describing your current assistant name. If asked what you know about the user, use only explicit conversation or supplied memory facts and say when none are available; never guess.`,
    product.company,
    product.domain,
    "Models:\n" + bulletList(product.models),
    "Plans and pricing:\n" + product.plans.map((plan) => `- ${plan.name}: web ${plan.id === "free" ? "$0" : planPrice(plan)}. ${planDetails(plan, options).join(" ")}`).join("\n"),
    creditsMode ? creditsPricingRule(creditsMode) : "Mandatory pricing-answer rule: For a plan question, state the correct web price and the complete listed access and limits for each plan asked about. Plus, Pro, and Max include monthly and rolling 5-hour token caps, image and document generations, and upload sizes. Free includes up to 15 AI requests in any 24-hour period, subject to a shared $0.25 included allowance each UTC calendar month. Lumen and Study share this allowance, and one message or action can use more than one AI request, plus upload sizes. Free also includes 2 image generations per week. Monthly token caps on Plus, Pro, and Max reset on the first day at 00:00 UTC. Do not describe Free as a token allowance or as unlimited monthly use. Do not describe Pro or Max model or image limits as unlimited unless the matching plan detail explicitly says so.",
    "Image & document credits are purchased on the web only.",
    "Do not say that any upload, message, model-access, price, or billing detail is undocumented when it appears in the Plans and pricing list above. Those entries are the current released facts and must be repeated accurately when requested.",
    `Refund policy: ${product.refunds}`,
    `Support: ${product.support}`,
    "Navigation:\n" + bulletList(product.navigation),
    "The VibhavGPT Guarantee:\n" + bulletList(product.guarantee),
    "Terms of Service summary:\n" + bulletList(modelSafeTermsRows(product)),
    "Privacy Policy summary:\n" + bulletList(modelSafePrivacyRows(product)),
    `Credits: ${product.credits}`,
    `Thinking effort: ${product.thinkingEffort}`,
    "Non-negotiable pricing output constraint: For any pricing, plan, billing, or model-access question, include every relevant complete plan fact line verbatim. Do not abbreviate, summarize, or replace a number with a vague label:\n" + product.plans.map((plan) => `- ${plan.name} (${plan.id === "free" ? "$0" : planPrice(plan)} on the web): ${planDetails(plan, options).join(" ")}`).join("\n"),
    "</vibhavgpt-product-knowledge>",
  ].join("\n");
}
