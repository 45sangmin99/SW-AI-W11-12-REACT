const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function childrenToVdom(node) {
  return Array.from(node.childNodes, domToVdom).filter(
    (child) => child !== null,
  );
}

export function domToVdom(node) {
  if (node?.nodeType === TEXT_NODE) {
    const text = node.nodeValue ?? "";
    return text.trim() ? text : null;
  }

  if (node?.nodeType !== ELEMENT_NODE) {
    return null;
  }

  const props = Object.fromEntries(
    Array.from(node.attributes, ({ name, value }) => [name, value]),
  );
  return {
    type: node.tagName.toLowerCase(),
    props,
    children: childrenToVdom(node),
  };
}

export function domContainerToVdom(container) {
  return {
    type: container.tagName.toLowerCase(),
    props: {},
    children: childrenToVdom(container),
  };
}
