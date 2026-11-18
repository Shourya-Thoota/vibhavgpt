-- Flatten folder-contained conversations into their parent project
UPDATE conversations
SET group_id = conversation_groups.parent_id
FROM conversation_groups
WHERE conversations.group_id = conversation_groups.id
  AND conversation_groups.kind = 'folder'
  AND conversation_groups.parent_id IS NOT NULL;

-- Flatten loose folder conversations into the global list
UPDATE conversations
SET group_id = NULL
FROM conversation_groups
WHERE conversations.group_id = conversation_groups.id
  AND conversation_groups.kind = 'folder'
  AND conversation_groups.parent_id IS NULL;
