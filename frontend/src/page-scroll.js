// Reset the document and the workspace's independent scroll surface after
// route content mounts. Conversation auto-scroll remains owned by Chat.
export function resetPageScroll() {
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  for (const node of [document.scrollingElement, document.querySelector(".workspace__main")]) {
    if (node) { node.scrollTop = 0; node.scrollLeft = 0; }
  }
}
