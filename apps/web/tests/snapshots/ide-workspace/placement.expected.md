- button "New session"
- button "Collapse sidebar":
  - img
- button "New session":
  - img
  - text: New Session
- text: Workspaces
- button "Search sessions":
  - img
- textbox "Search sessions..."
- button "View options":
  - img
- button "Add workspace":
  - img
- tree "Sessions":
  - treeitem "IDE snapshot" [expanded]:
    - img
    - text: IDE snapshot
  - treeitem "New Session" [selected]
- button "Settings":
  - img
  - text: Settings
- button "Editor" [disabled] [expanded]:
  - img
- text: Into the Unknown Preview
- button "Choose workspace":
  - img
  - text: IDE snapshot
  - img
- button "Standard mode":
  - img
  - text: Standard mode
  - img
- textbox "Describe what you want to build"
- button "Commands":
  - img
- 'button "Access mode, current: Workspace Write"': Workspace Write
- button "Select model, current DeepSeek-V4-Flash":
  - text: DeepSeek-V4-Flash
  - img
- button "Send message" [disabled]
- separator "Editor"
- region "Editor":
  - img
  - combobox:
    - option "IDE snapshot" [selected]
  - button "Close editor":
    - img
  - complementary:
    - text: Files
    - tree "Files":
      - treeitem "README.md"
      - treeitem "src"
  - main:
    - tablist
    - text: Choose a text file from the file tree

# Docked editor layout

| state | visible panels | overlapping pairs | shared edges | editor at right | editor in overlay | separator | width transfer conserved |
| --- | --- | --- | --- | --- | --- | --- | --- |
| wide open | sidebar → conversation → editor | 0 | true | true | false | true | — |
| wide after drag | sidebar → conversation → editor | 0 | true | true | false | true | true |
| narrow exclusive | sidebar → editor | 0 | true | true | false | false | — |
| wide restored | sidebar → conversation → editor | 0 | true | true | false | true | — |
| wide closed | sidebar → conversation | 0 | true | — | false | false | — |
