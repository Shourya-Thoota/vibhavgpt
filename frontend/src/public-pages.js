export const SITE_ORIGIN = "https://vibhavgpt.com";
export const BRAND_IMAGE = `${SITE_ORIGIN}/brand/vibhavgpt-icon-512.png`;
export const DELETION_PLAN_NOTICE = "Cancel your plan before deleting your account. Pansophy LLC is not responsible for subscriptions that were not cancelled.";

// Shared by the browser, HTML build, sitemap and visible FAQ blocks.
export const PUBLIC_PAGES = {
  "/home": {
    label: "Home", title: "VibhavGPT: Private AI Chat, Image Creation and Study",
    description: "Chat, create images and study with VibhavGPT, a private AI workspace for ideas, learning and everyday questions. No ads or data sales. Made by Vibhav Thoota.",
  },
  "/pricing": {
    label: "Pricing", title: "VibhavGPT Pricing: Compare Free, Plus and Pro Plans",
    description: "Compare VibhavGPT Free, Plus and Pro plans, monthly or yearly billing, model allowances, image creation and document generation. Made by Vibhav Thoota.",
    faq: [
      ["Which plan should I choose?", "Start with Free if you want to try AI chat and Study before subscribing. Plus gives you more room for everyday use and includes image and document generation. Pro offers larger allowances and access to the flagship model for difficult work. Compare the model access and allowances above with the work you expect to do; a paid plan still has usage limits."],
      ["How do token allowances reset?", "Both the messages you send and the responses you receive count as tokens. Monthly token allowances reset on the first day of each calendar month at 00:00 UTC. A separate rolling five-hour cap applies to each model. Usage becomes available again as older tokens leave that window. The Usage page shows consumption, including pending reservations, so check it before starting a long request."],
      ["Can I change or cancel my plan?", "You can manage a web subscription in Plan and billing. Choosing yearly billing changes the billing period; the table shows the plan price and the yearly saving. Cancellation stops renewal, while access continues through the paid period. If a subscription was bought in the Android app, its billing details and management follow that subscription rather than a new web purchase."],
      ["Do Flex Credits remove chat limits?", "No. Chat and Study token caps still apply when you have Flex Credits. Credits are for eligible generation features beyond the included allowance; they do not unlock paid features on Free. Read the comparison and your account's billing information before buying so you know which allowances are included and which extra generations use credits."],
    ],
  },
  "/terms": {
    label: "Terms of Service", title: "VibhavGPT Terms of Service: Accounts, Billing and Use",
    description: "Read the Pansophy LLC agreement for VibhavGPT accounts, acceptable use, subscriptions, billing, cancellation and service limitations. Made by Vibhav Thoota.",
  },
  "/privacy": {
    label: "Privacy Policy", title: "VibhavGPT Privacy Policy: Your Data, Rights and Choices",
    description: "Learn how Pansophy LLC handles VibhavGPT account and chat data, privacy choices, service providers, retention, exports and deletion. Made by Vibhav Thoota.",
  },
  "/guarantee": {
    label: "Guarantee", title: "The VibhavGPT Guarantee: Privacy and Control of Your Data",
    description: "Pansophy LLC promises no training on your VibhavGPT chats, no data sales, no ads, and control to export or delete your account data. Made by Vibhav Thoota.",
    faq: [
      ["Does the Guarantee apply to every plan?", "Yes. Pansophy LLC operates VibhavGPT, and these four promises apply whether you use Free, Plus or Pro. Paying for a larger allowance changes what you can use, not the promise about training, selling data or showing ads. The Guarantee is included in our Terms of Service; read those terms alongside the Privacy Policy for the complete account and service rules."],
      ["Does no training mean my messages are never processed?", "Your messages and relevant context must be processed to produce a response. Service providers also support hosting, account security and other necessary operations. No training is a promise about how your chats are used, not a promise that inference happens without processing them. Our Privacy Policy explains the categories of data and providers involved and the purposes for that processing."],
      ["How can I keep a copy or leave the service?", "Use Settings, then Your data, to export your account data before deletion. The account-deletion page explains the sign-in and email routes, what leaves active systems and what may remain in restricted backups or billing records. Cancel your plan before deleting your account. Deletion cannot be undone, so save any conversations or files you want to keep first."],
    ],
  },
  "/account-deletion": {
    label: "Account deletion", title: "Delete Your VibhavGPT Account: Data and Subscription Help",
    description: "Delete your VibhavGPT account in Settings or request deletion by email. Cancel your plan first; read about data removal and retention. Made by Vibhav Thoota.",
    faq: [
      ["Can I delete my account without the Android app?", "Yes. Open the web confirmation from this page and sign in to your VibhavGPT account. If you cannot sign in, email support@pansophy.com from your account address with Account deletion request in the subject. We may need to verify ownership before removing the account."],
      ["Do I need to cancel my subscription first?", DELETION_PLAN_NOTICE + " Open Plan and billing to check your subscription and use the management option for where you purchased it. Confirm cancellation with the billing provider before deleting your account."],
      ["Can deleted data be recovered?", "Account deletion is permanent. Export the data you want to keep from Settings before confirming. Active account data is removed; restricted disaster-recovery backups rotate out within 12 months. Billing providers may retain transaction records under their own policies and legal obligations."],
    ],
  },
  "/android": {
    label: "Android", title: "VibhavGPT for Android: Official App Download and Setup",
    description: "Download the official VibhavGPT Android APK from Pansophy LLC, follow installation steps, check device requirements and verify files. Made by Vibhav Thoota.",
    faq: [
      ["Where should I download the Android app?", "Use the Download APK link on this official VibhavGPT page. Pansophy LLC operates VibhavGPT and distributes this Android release directly. Check the version, device requirements and release notes here before installing. Avoid copies from unfamiliar download sites. The SHA-256 checksum below lets you compare the file you downloaded with the official release."],
      ["Why does Android ask for an installation permission?", "A direct APK download is installed from your browser or file manager. Android may ask you to allow that app to install from this source. Grant the permission only for the official file you have just downloaded, follow the installation prompt, and turn the permission off again afterward if you do not need it. This is a device permission, not a VibhavGPT subscription."],
      ["Can I use the same account on the web and Android?", "Yes. Sign in with your existing VibhavGPT account to use the same projects and saved memory on your phone. Chat, image creation and Study are available according to your plan and allowances. If you prefer not to install an APK, open the browser workspace instead. You can also manage your data and request account deletion through the website without reinstalling the app."],
      ["How do I check the downloaded file?", "Compare its SHA-256 digest with the checksum shown in Verify your download. The commands on this page show how to calculate a digest on a computer. A matching checksum confirms that the file matches this release; it does not change your account permissions. For installation or account questions, contact support@pansophy.com and describe the version and device issue."],
    ],
  },
  "/vibhavgpt-windows": {
    label: "Windows", title: "VibhavGPT Windows: Official Desktop App Download and Setup",
    description: "Download the official VibhavGPT Windows app for Windows 10 and 11 from Pansophy LLC, with install steps, requirements and file checks. Made by Vibhav Thoota.",
    faq: [
      ["Why does Windows show a SmartScreen warning?", "The installer is not yet signed with a code-signing certificate, so SmartScreen does not recognize the publisher and shows a warning before it runs. Download the installer only from this official VibhavGPT page and compare its SHA-256 checksum with the one shown here. If they match, select More info and then Run anyway to continue with the installation."],
      ["Which versions of Windows are supported?", "VibhavGPT for Windows runs on 64-bit editions of Windows 10 and Windows 11. It needs an internet connection, because the app opens the same live VibhavGPT workspace you use in a browser. This installer is built for x64 processors, so 32-bit editions of Windows cannot run it. If your computer cannot run it, you can still use VibhavGPT in any modern browser."],
      ["Can I use the same account on the web and Windows?", "Yes. Sign in with your existing VibhavGPT account, by email or with the same sign-in option you use on the web, to use the same projects, chats and saved memory on your computer. Signing in with an external account opens your default browser and then returns you to the app. Chat, image creation and Study are available according to your plan and allowances, exactly as they are on the web."],
      ["How do I check or remove the app?", "Compare the installer's SHA-256 digest with the checksum shown in Verify your download; the command on this page calculates it. A matching checksum confirms that the file matches this release. To remove the app, open Settings, then Apps, find VibhavGPT and choose Uninstall. Removing the app does not delete your account; manage your data on the website."],
    ],
  },
};

export function publicPagePath(pathname) {
  const path = pathname.replace(/\/index\.html$/, "").replace(/\.html$/, "").replace(/\/$/, "") || "/";
  return ({ "/": "/home", "/terms-of-service": "/terms", "/privacy-policy": "/privacy" })[path] ?? path;
}

export function pageStructuredData(pathname) {
  const path = publicPagePath(pathname);
  const page = PUBLIC_PAGES[path];
  const graph = [
    { "@type": "Organization", "@id": `${SITE_ORIGIN}/#organization`, name: "Pansophy LLC", alternateName: "VibhavGPT", url: `${SITE_ORIGIN}/home`, logo: BRAND_IMAGE, email: "support@pansophy.com",
      founder: { "@type": "Person", "@id": `${SITE_ORIGIN}/#founder`, name: "Vibhav Thoota", jobTitle: "Founder" } },
    { "@type": "WebSite", "@id": `${SITE_ORIGIN}/#website`, name: "VibhavGPT", url: `${SITE_ORIGIN}/`, publisher: { "@id": `${SITE_ORIGIN}/#organization` }, creator: { "@id": `${SITE_ORIGIN}/#founder` } },
    { "@type": "SoftwareApplication", "@id": `${SITE_ORIGIN}/#software`, name: "VibhavGPT", url: `${SITE_ORIGIN}/home`, applicationCategory: "ProductivityApplication", operatingSystem: "Web, Android", publisher: { "@id": `${SITE_ORIGIN}/#organization` }, creator: { "@id": `${SITE_ORIGIN}/#founder` } },
  ];
  if (page && path !== "/home") graph.push({
    "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_ORIGIN}/home` },
      { "@type": "ListItem", position: 2, name: page.label, item: `${SITE_ORIGIN}${path}` },
    ],
  });
  if (page?.faq) graph.push({ "@type": "FAQPage", mainEntity: page.faq.map(([question, answer]) => ({ "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer } })) });
  return { "@context": "https://schema.org", "@graph": graph };
}
