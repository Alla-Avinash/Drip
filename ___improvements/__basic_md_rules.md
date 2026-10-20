
## **Index**

1. [[#Database]]
2. [[#Markdown Rules]]
3. 


ok now this makes a lot of sense to be helpful..... 
1. help me with this 
2. is this working 
	1. i want help now ..... 

### Database
##### **1. Vault**
- A **vault** = one folder on your computer.
- Inside it: your notes (Markdown files), images, PDFs, etc.
- Obsidian treats the vault folder as your **database**.
- You can have multiple vaults (e.g., “Study Notes”, “Work Docs”).
##### **2. Files**
- Notes are just plain `.md` Markdown files.
- Each note can be as short or long as you want.
- File name = note title (used in graph links).
##### **3. Folders**
- Just regular folders in your vault.
- Used for organization (e.g., `Math/`, `CS/`, `Personal/`).    
- Folders don’t affect graph view, only how you browse files.

[[pin1]]


### Markdown Rules
- **Headings (different sizes):**
	- # H1
		## H2
		### H3
		#### h4
- **Bold / Italic:**
		**bold**   *italic*   ~~strikethrough~~
- **Lists:**
	- Bullet list  
		- Nested bullet 
	1. Numbered list
	2. Another item
	3. another item
- **Links:**
	- `#` in Obsidian links is **used to indicate a “sub-location” within a file**
	- [[ai]]    → you no need to specify the path to the note as they store the path internally. and every path is stored from the vault which is chosen in obsidian
	- we have 2 different files with the same names - to make a distinction in the names you can manage the settings 
		- [[Obsidian basics/folder2/Internal|Internal]]
		- [[Obsidian basics/folder1/Internal|Internal]]
	- [Hidden](Hidden.md) - This is a clickable link in the note but **won’t appear as a node in the graph**.
	- [External link](https://example.com)  
	- [[Internal Note 6454]]
	- [[Internal Note 6454#Section Heading]]  → link to a heading
	- [[Internal Note 6454#^blockID]]              → link to a block/paragraph
	- ![[Internal Note 6454]]
	→ to display the referenced note in this note →  (embed another note inside this note)
  
- **Images:**
	- ![Alt text](image.png)
	- [[image2.png]]
- **Blockquotes:**
> 	This is a quote

- **Code:**
	`inline code`   
	```	python
	def hello():     
		print("Hello")
	```
- **Tags:**
	#project #idea #AI
	- Tags are just `#something` anywhere in a note.
	- They are **metadata** attached to a note (or even a paragraph/block if you want).
	- They don’t have to match note headings; they can be anything meaningful:
		- Topics: `#AI`, `#Math`
		- Status: `#todo`, `#done`
		- Context: `#lecture1`, `#reference`
	- They help in 'search and retrieval and grouping' in text files and also help in 'filtering and grouping' in graph view
- **Task lists:**
	- [ ] Todo item 
	- [x] Done item
	- [ ] 
- **Horizontal line:**
---




