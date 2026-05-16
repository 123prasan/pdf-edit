with open('src/types.ts', 'r') as f:
    content = f.read()

content = content.replace(
    "fontColor?: string\n  /** Ink",
    "fontColor?: string\n  fontStyle?: string\n  fontWeight?: string\n  /** Ink"
)

with open('src/types.ts', 'w') as f:
    f.write(content)

print('Updated types.ts')
