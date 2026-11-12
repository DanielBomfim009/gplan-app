module.exports = {
  content: ['../v2/index.html', '../v2/app.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'], display: ['Space Grotesk', 'sans-serif'] },
      colors: {
        'app': { 'bg': '#0d1f2d', 'card': '#132a3c' },
        'brand': { 'DEFAULT': '#00b4a0', 'light': '#00d4b8', 'dark': '#008577' },
        'income': '#00c853',
        'expense': '#ff5252',
        'warning': '#ffb300',
        'purple': '#9c7cfa',
        'orange': '#ff8a50'
      }
    }
  }
};
