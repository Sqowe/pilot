# AI Web Design Guidelines - sqowe Brand

## Overview

This document provides detailed instructions for implementing web designs that comply with the sqowe corporate brand guidelines. Use this as a reference for all HTML/CSS and React development projects.

---

## 1. Color System

### 1.1 Primary Colors

| Color Name   | HEX       | RGB         | CMYK        | PMS    | Usage                                     |
| ------------ | --------- | ----------- | ----------- | ------ | ----------------------------------------- |
| Dark Ground  | `#222222` | 34/34/34    | 72/65/65/72 | 419 C  | Primary backgrounds, footers, headers     |
| Light Purple | `#8E88A3` | 142/136/163 | 48/45/22/1  | 5285 C | Accent elements, hover states, highlights |

### 1.2 Secondary Colors

| Color Name  | HEX       | RGB         | CMYK        | PMS    | Usage                                       |
| ----------- | --------- | ----------- | ----------- | ------ | ------------------------------------------- |
| Light Grey  | `#B2B3B2` | 178/179/178 | 31/24/26/0  | 421 C  | Borders, dividers, subtle backgrounds       |
| Dark Purple | `#5B5377` | 91/83/119   | 71/71/31/13 | 5275 C | Secondary buttons, cards, featured sections |

### 1.3 CSS Variables

```css
:root {
  /* Primary Colors */
  --sqowe-dark-ground: #222222;
  --sqowe-light-purple: #8e88a3;

  /* Secondary Colors */
  --sqowe-light-grey: #b2b3b2;
  --sqowe-dark-purple: #5b5377;

  /* Gradient */
  --sqowe-gradient: linear-gradient(135deg, #5b5377 0%, #8e88a3 100%);

  /* Semantic Colors */
  --color-background-dark: var(--sqowe-dark-ground);
  --color-background-light: #ffffff;
  --color-text-primary: #222222;
  --color-text-secondary: #5b5377;
  --color-accent: #8e88a3;
  --color-border: #b2b3b2;
}
```

### 1.4 Color Usage Guidelines

**DO:**

- Use Dark Ground (#222222) for headers, footers, and dark sections
- Use Light Purple (#8E88A3) for interactive elements and highlights
- Use Dark Purple (#5B5377) for secondary emphasis
- Ensure sufficient contrast (WCAG AA minimum)

**DON'T:**

- Mix colors randomly without considering the brand hierarchy
- Use colors outside the defined palette
- Apply low contrast combinations that hurt readability

---

## 2. Typography

### 2.1 Font Family

**Primary Font: Montserrat** (Google Fonts)

- Available at: https://fonts.googleapis.com/specimen/Montserrat
- Weights: Light (300), Regular (400), Medium (500), Bold (700)

### 2.2 HTML Implementation

```html
<!-- In <head> section -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;700&display=swap"
  rel="stylesheet"
/>
```

### 2.3 CSS Setup

```css
:root {
  /* Font Family */
  --font-primary: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  /* Font Weights */
  --font-light: 300;
  --font-regular: 400;
  --font-medium: 500;
  --font-bold: 700;

  /* Font Sizes */
  --font-size-h1: 3rem; /* 48px */
  --font-size-h2: 2.25rem; /* 36px */
  --font-size-h3: 1.875rem; /* 30px */
  --font-size-h4: 1.5rem; /* 24px */
  --font-size-h5: 1.25rem; /* 20px */
  --font-size-h6: 1.125rem; /* 18px */
  --font-size-body: 1rem; /* 16px */
  --font-size-small: 0.875rem; /* 14px */

  /* Line Heights */
  --line-height-tight: 1.25;
  --line-height-normal: 1.6;
  --line-height-relaxed: 1.8;
}

body {
  font-family: var(--font-primary);
  font-weight: var(--font-regular);
  font-size: var(--font-size-body);
  line-height: var(--line-height-normal);
  color: var(--color-text-primary);
}
```

### 2.4 Typography Scale

```css
h1,
.h1 {
  font-size: var(--font-size-h1);
  font-weight: var(--font-bold);
  line-height: var(--line-height-tight);
  margin-bottom: 1.5rem;
}

h2,
.h2 {
  font-size: var(--font-size-h2);
  font-weight: var(--font-bold);
  line-height: var(--line-height-tight);
  margin-bottom: 1.25rem;
}

h3,
.h3 {
  font-size: var(--font-size-h3);
  font-weight: var(--font-medium);
  line-height: var(--line-height-tight);
  margin-bottom: 1rem;
}

h4,
.h4 {
  font-size: var(--font-size-h4);
  font-weight: var(--font-medium);
  line-height: var(--line-height-normal);
  margin-bottom: 1rem;
}

p,
.body-text {
  font-size: var(--font-size-body);
  font-weight: var(--font-regular);
  line-height: var(--line-height-relaxed);
  margin-bottom: 1rem;
  max-width: 70ch; /* Optimal reading width */
}

.text-light {
  font-weight: var(--font-light);
}

.text-small {
  font-size: var(--font-size-small);
}
```

### 2.5 Typography Usage Guidelines

**Headers:**

- Use Montserrat Bold for H1-H2
- Use Montserrat Medium for H3-H6
- Keep headers concise and impactful
- Use sentence case or title case consistently

**Body Copy:**

- Use Montserrat Regular for main content
- Use Montserrat Light for supporting text or captions
- Maintain line length of 60-75 characters for optimal readability
- Use line-height of 1.6-1.8 for body text

### 2.6 Block Element Centering

When using `.text-center` on containers with block elements that have constrained widths (like `max-width: 70ch` on paragraphs):

**Rule:** Always include `margin-inline: auto` to center the block element itself, not just its text content.

```css
.text-center p {
  margin-inline: auto;
}
```

**Why:** `text-align: center` only centers inline content within the element. Block elements with `max-width` remain left-aligned unless explicitly centered with `margin-inline: auto`.

**Example issue:** Two paragraphs with different text lengths appear misaligned because each has different rendered widths despite both being "centered."

---

## 3. Logo Usage

### 3.1 Logo Variants

**Available Versions:**

1. **Dark Logotype** - Use on light backgrounds (white, light grey)
2. **Light Logotype** - Use on dark backgrounds (#222222, photos with overlay)
3. **Gradient Logotype** - Use for hero sections or special features
4. **One Color** - Use for simplified applications or small sizes

### 3.2 Logo Implementation

```html
<!-- Header with dark logo -->
<header class="header-light">
  <img src="/assets/logo-dark.svg" alt="sqowe" class="logo" />
</header>

<!-- Header with light logo -->
<header class="header-dark">
  <img src="/assets/logo-light.svg" alt="sqowe" class="logo" />
</header>
```

```css
.logo {
  height: 40px; /* Standard size for header */
  width: auto;
  display: block;
}

/* Responsive logo sizing */
@media (max-width: 768px) {
  .logo {
    height: 32px;
  }
}

@media (min-width: 1200px) {
  .logo {
    height: 48px;
  }
}
```

### 3.3 Logo Clear Space

Maintain clear space around the logo equal to the height of the "o" in sqowe (approximately 25% of logo height).

```css
.logo-container {
  padding: calc(0.25 * 40px); /* 25% of logo height */
}
```

### 3.4 Logo Don'ts

**DON'T:**

- Stretch or distort the logo
- Change logo colors outside of approved variants
- Place logo on busy backgrounds without sufficient contrast
- Use low-resolution versions
- Rotate the logo
- Add effects (shadows, outlines, glows)

---

## 4. Layout System

### 4.1 Grid System

```css
:root {
  /* Container Widths */
  --container-xs: 640px;
  --container-sm: 768px;
  --container-md: 1024px;
  --container-lg: 1280px;
  --container-xl: 1536px;

  /* Spacing Scale */
  --space-xs: 0.25rem; /* 4px */
  --space-sm: 0.5rem; /* 8px */
  --space-md: 1rem; /* 16px */
  --space-lg: 1.5rem; /* 24px */
  --space-xl: 2rem; /* 32px */
  --space-2xl: 3rem; /* 48px */
  --space-3xl: 4rem; /* 64px */
  --space-4xl: 6rem; /* 96px */
}

.container {
  width: 100%;
  max-width: var(--container-lg);
  margin-left: auto;
  margin-right: auto;
  padding-left: var(--space-lg);
  padding-right: var(--space-lg);
}

@media (max-width: 768px) {
  .container {
    padding-left: var(--space-md);
    padding-right: var(--space-md);
  }
}
```

### 4.2 Section Spacing

```css
.section {
  padding-top: var(--space-4xl);
  padding-bottom: var(--space-4xl);
}

@media (max-width: 768px) {
  .section {
    padding-top: var(--space-3xl);
    padding-bottom: var(--space-3xl);
  }
}

.section-header {
  margin-bottom: var(--space-3xl);
  text-align: center;
}
```

---

## 5. Component Styles

### 5.1 Buttons

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.75rem 2rem;
  font-family: var(--font-primary);
  font-size: var(--font-size-body);
  font-weight: var(--font-medium);
  text-decoration: none;
  border-radius: 6px;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all 0.3s ease;
  line-height: 1;
}

/* Primary Button */
.btn-primary {
  background-color: var(--sqowe-dark-purple);
  color: white;
  border-color: var(--sqowe-dark-purple);
}

.btn-primary:hover {
  background-color: var(--sqowe-light-purple);
  border-color: var(--sqowe-light-purple);
}

/* Secondary Button */
.btn-secondary {
  background-color: transparent;
  color: var(--sqowe-dark-purple);
  border-color: var(--sqowe-dark-purple);
}

.btn-secondary:hover {
  background-color: var(--sqowe-dark-purple);
  color: white;
}

/* Gradient Button */
.btn-gradient {
  background: var(--sqowe-gradient);
  color: white;
  border: none;
}

.btn-gradient:hover {
  opacity: 0.9;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(91, 83, 119, 0.3);
}

/* Button Sizes */
.btn-small {
  padding: 0.5rem 1.5rem;
  font-size: var(--font-size-small);
}

.btn-large {
  padding: 1rem 2.5rem;
  font-size: 1.125rem;
}
```

### 5.2 Cards

```css
.card {
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  padding: var(--space-xl);
  transition: all 0.3s ease;
}

.card:hover {
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  transform: translateY(-4px);
}

.card-header {
  margin-bottom: var(--space-lg);
}

.card-title {
  font-size: var(--font-size-h4);
  font-weight: var(--font-bold);
  color: var(--sqowe-dark-purple);
  margin-bottom: var(--space-sm);
}

.card-description {
  font-size: var(--font-size-body);
  color: var(--sqowe-light-grey);
  line-height: var(--line-height-relaxed);
}

/* Card with dark background */
.card-dark {
  background: var(--sqowe-dark-ground);
  color: white;
}

.card-dark .card-title {
  color: var(--sqowe-light-purple);
}

.card-dark .card-description {
  color: rgba(255, 255, 255, 0.8);
}
```

### 5.3 Navigation

```css
.navbar {
  background: white;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  position: sticky;
  top: 0;
  z-index: 1000;
}

.navbar-container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-lg) var(--space-xl);
}

.navbar-menu {
  display: flex;
  gap: var(--space-xl);
  list-style: none;
  margin: 0;
  padding: 0;
}

.navbar-link {
  font-weight: var(--font-medium);
  color: var(--sqowe-dark-ground);
  text-decoration: none;
  transition: color 0.2s ease;
}

.navbar-link:hover,
.navbar-link.active {
  color: var(--sqowe-light-purple);
}

/* Dark navbar variant */
.navbar-dark {
  background: var(--sqowe-dark-ground);
}

.navbar-dark .navbar-link {
  color: white;
}

.navbar-dark .navbar-link:hover,
.navbar-dark .navbar-link.active {
  color: var(--sqowe-light-purple);
}
```

### 5.4 Forms

```css
.form-group {
  margin-bottom: var(--space-lg);
}

.form-label {
  display: block;
  font-weight: var(--font-medium);
  color: var(--sqowe-dark-purple);
  margin-bottom: var(--space-sm);
}

.form-input,
.form-textarea,
.form-select {
  width: 100%;
  padding: 0.75rem 1rem;
  font-family: var(--font-primary);
  font-size: var(--font-size-body);
  color: var(--sqowe-dark-ground);
  background: white;
  border: 2px solid var(--sqowe-light-grey);
  border-radius: 6px;
  transition: all 0.3s ease;
}

.form-input:focus,
.form-textarea:focus,
.form-select:focus {
  outline: none;
  border-color: var(--sqowe-light-purple);
  box-shadow: 0 0 0 3px rgba(142, 136, 163, 0.1);
}

.form-textarea {
  resize: vertical;
  min-height: 120px;
}

.form-help {
  font-size: var(--font-size-small);
  color: var(--sqowe-light-grey);
  margin-top: var(--space-xs);
}
```

### 5.5 Hero Section

```css
.hero {
  position: relative;
  min-height: 600px;
  display: flex;
  align-items: center;
  background: var(--sqowe-dark-ground);
  color: white;
  overflow: hidden;
}

/* Hero with photo background */
.hero-photo {
  background-size: cover;
  background-position: center;
}

.hero-photo::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(34, 34, 34, 0.7);
}

.hero-content {
  position: relative;
  z-index: 1;
  max-width: 800px;
}

.hero-title {
  font-size: 3.5rem;
  font-weight: var(--font-bold);
  margin-bottom: var(--space-lg);
  line-height: 1.2;
}

.hero-subtitle {
  font-size: 1.5rem;
  font-weight: var(--font-light);
  color: var(--sqowe-light-purple);
  margin-bottom: var(--space-2xl);
}

@media (max-width: 768px) {
  .hero {
    min-height: 400px;
  }

  .hero-title {
    font-size: 2rem;
  }

  .hero-subtitle {
    font-size: 1.125rem;
  }
}
```

---

## 6. Background Styles

### 6.1 Photo Backgrounds

```css
.bg-photo {
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  position: relative;
}

.bg-photo-overlay {
  position: relative;
}

.bg-photo-overlay::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(34, 34, 34, 0.6);
  z-index: 1;
}

.bg-photo-overlay > * {
  position: relative;
  z-index: 2;
}
```

### 6.2 Gradient Backgrounds

```css
.bg-gradient {
  background: var(--sqowe-gradient);
}

.bg-gradient-vertical {
  background: linear-gradient(180deg, #5b5377 0%, #8e88a3 100%);
}

.bg-gradient-subtle {
  background: linear-gradient(135deg, rgba(91, 83, 119, 0.05) 0%, rgba(142, 136, 163, 0.05) 100%);
}
```

### 6.3 Solid Backgrounds

```css
.bg-dark {
  background-color: var(--sqowe-dark-ground);
  color: white;
}

.bg-light {
  background-color: white;
  color: var(--sqowe-dark-ground);
}

.bg-grey {
  background-color: var(--sqowe-light-grey);
  color: var(--sqowe-dark-ground);
}

.bg-purple {
  background-color: var(--sqowe-dark-purple);
  color: white;
}
```

---

## 7. React Components

### 7.1 Button Component

```jsx
import React from 'react';
import './Button.css';

const Button = ({
  children,
  variant = 'primary',
  size = 'medium',
  onClick,
  className = '',
  ...props
}) => {
  const buttonClass = `btn btn-${variant} btn-${size} ${className}`;

  return (
    <button className={buttonClass} onClick={onClick} {...props}>
      {children}
    </button>
  );
};

export default Button;
```

**Usage:**

```jsx
<Button variant="primary">Get Started</Button>
<Button variant="secondary" size="large">Learn More</Button>
<Button variant="gradient">Special Offer</Button>
```

### 7.2 Card Component

```jsx
import React from 'react';
import './Card.css';

const Card = ({ title, description, children, variant = 'light', className = '' }) => {
  return (
    <div className={`card card-${variant} ${className}`}>
      {title && (
        <div className="card-header">
          <h3 className="card-title">{title}</h3>
        </div>
      )}
      {description && <p className="card-description">{description}</p>}
      {children}
    </div>
  );
};

export default Card;
```

**Usage:**

```jsx
<Card
  title="Feature Title"
  description="Brief description of the feature"
  variant="light"
/>

<Card variant="dark">
  <h3 className="card-title">Custom Content</h3>
  <p>Your custom content here</p>
</Card>
```

### 7.3 Hero Component

```jsx
import React from 'react';
import './Hero.css';
import Button from './Button';

const Hero = ({ title, subtitle, backgroundImage, children }) => {
  const heroStyle = backgroundImage
    ? {
        backgroundImage: `url(${backgroundImage})`,
      }
    : {};

  const heroClass = backgroundImage ? 'hero hero-photo' : 'hero';

  return (
    <section className={heroClass} style={heroStyle}>
      <div className="container">
        <div className="hero-content">
          <h1 className="hero-title">{title}</h1>
          {subtitle && <p className="hero-subtitle">{subtitle}</p>}
          {children}
        </div>
      </div>
    </section>
  );
};

export default Hero;
```

**Usage:**

```jsx
<Hero
  title="Welcome to sqowe"
  subtitle="Building the future of technology"
  backgroundImage="/images/hero-bg.jpg"
>
  <div style={{ display: 'flex', gap: '1rem' }}>
    <Button variant="gradient" size="large">
      Get Started
    </Button>
    <Button variant="secondary" size="large">
      Learn More
    </Button>
  </div>
</Hero>
```

### 7.4 Navigation Component

```jsx
import React, { useState } from 'react';
import './Navigation.css';

const Navigation = ({ logo, logoAlt = 'sqowe', links = [], variant = 'light' }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <nav className={`navbar navbar-${variant}`}>
      <div className="navbar-container container">
        <a href="/" className="navbar-logo">
          <img src={logo} alt={logoAlt} className="logo" />
        </a>

        <button className="navbar-toggle" onClick={() => setIsOpen(!isOpen)}>
          <span></span>
          <span></span>
          <span></span>
        </button>

        <ul className={`navbar-menu ${isOpen ? 'active' : ''}`}>
          {links.map((link, index) => (
            <li key={index}>
              <a href={link.href} className={`navbar-link ${link.active ? 'active' : ''}`}>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
};

export default Navigation;
```

**Usage:**

```jsx
<Navigation
  logo="/assets/logo-dark.svg"
  variant="light"
  links={[
    { label: 'Home', href: '/', active: true },
    { label: 'About', href: '/about' },
    { label: 'Services', href: '/services' },
    { label: 'Contact', href: '/contact' },
  ]}
/>
```

### 7.5 Form Component

```jsx
import React, { useState } from 'react';
import './Form.css';
import Button from './Button';

const Form = ({ onSubmit, children }) => {
  const handleSubmit = (e) => {
    e.preventDefault();
    if (onSubmit) onSubmit(e);
  };

  return (
    <form onSubmit={handleSubmit} className="form">
      {children}
    </form>
  );
};

const FormGroup = ({
  label,
  name,
  type = 'text',
  placeholder,
  required = false,
  helpText,
  value,
  onChange,
}) => {
  return (
    <div className="form-group">
      <label htmlFor={name} className="form-label">
        {label} {required && <span className="required">*</span>}
      </label>

      {type === 'textarea' ? (
        <textarea
          id={name}
          name={name}
          className="form-textarea"
          placeholder={placeholder}
          required={required}
          value={value}
          onChange={onChange}
        />
      ) : (
        <input
          type={type}
          id={name}
          name={name}
          className="form-input"
          placeholder={placeholder}
          required={required}
          value={value}
          onChange={onChange}
        />
      )}

      {helpText && <p className="form-help">{helpText}</p>}
    </div>
  );
};

Form.Group = FormGroup;

export default Form;
```

**Usage:**

```jsx
<Form onSubmit={handleSubmit}>
  <Form.Group label="Full Name" name="name" required placeholder="John Doe" />

  <Form.Group label="Email" name="email" type="email" required placeholder="john@example.com" />

  <Form.Group
    label="Message"
    name="message"
    type="textarea"
    placeholder="Your message here..."
    helpText="Please provide as much detail as possible"
  />

  <Button type="submit" variant="primary" size="large">
    Submit
  </Button>
</Form>
```

---

## 8. Complete HTML Template

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>sqowe - Corporate Website</title>

    <!-- Google Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;700&display=swap"
      rel="stylesheet"
    />

    <!-- Styles -->
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <!-- Navigation -->
    <nav class="navbar">
      <div class="navbar-container container">
        <a href="/" class="navbar-logo">
          <img src="/assets/logo-dark.svg" alt="sqowe" class="logo" />
        </a>

        <ul class="navbar-menu">
          <li><a href="/" class="navbar-link active">Home</a></li>
          <li><a href="/about" class="navbar-link">About</a></li>
          <li><a href="/services" class="navbar-link">Services</a></li>
          <li><a href="/contact" class="navbar-link">Contact</a></li>
        </ul>
      </div>
    </nav>

    <!-- Hero Section -->
    <section class="hero hero-photo" style="background-image: url('/images/hero-bg.jpg')">
      <div class="container">
        <div class="hero-content">
          <h1 class="hero-title">Welcome to sqowe</h1>
          <p class="hero-subtitle">Building the future of technology</p>
          <div style="display: flex; gap: 1rem;">
            <a href="/get-started" class="btn btn-gradient btn-large">Get Started</a>
            <a href="/learn-more" class="btn btn-secondary btn-large">Learn More</a>
          </div>
        </div>
      </div>
    </section>

    <!-- Features Section -->
    <section class="section">
      <div class="container">
        <div class="section-header">
          <h2>Our Features</h2>
          <p>Discover what makes us different</p>
        </div>

        <div class="grid grid-3">
          <div class="card">
            <h3 class="card-title">Innovation</h3>
            <p class="card-description">
              Leading the way with cutting-edge technology and forward-thinking solutions.
            </p>
          </div>

          <div class="card">
            <h3 class="card-title">Reliability</h3>
            <p class="card-description">
              Trusted by thousands of clients worldwide for consistent, high-quality service.
            </p>
          </div>

          <div class="card">
            <h3 class="card-title">Support</h3>
            <p class="card-description">
              Dedicated team available 24/7 to ensure your success at every step.
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- CTA Section -->
    <section class="section bg-gradient">
      <div class="container" style="text-align: center;">
        <h2 style="color: white; margin-bottom: 1rem;">Ready to Get Started?</h2>
        <p style="color: rgba(255,255,255,0.9); font-size: 1.25rem; margin-bottom: 2rem;">
          Join thousands of satisfied clients today
        </p>
        <a href="/contact" class="btn btn-primary btn-large">Contact Us</a>
      </div>
    </section>

    <!-- Footer -->
    <footer class="bg-dark" style="padding: 4rem 0 2rem;">
      <div class="container">
        <div class="grid grid-4">
          <div>
            <img
              src="/assets/logo-light.svg"
              alt="sqowe"
              class="logo"
              style="margin-bottom: 1rem;"
            />
            <p style="color: rgba(255,255,255,0.7);">Building the future of technology</p>
          </div>

          <div>
            <h4 style="color: var(--sqowe-light-purple); margin-bottom: 1rem;">Company</h4>
            <ul style="list-style: none; padding: 0;">
              <li style="margin-bottom: 0.5rem;">
                <a href="/about" style="color: rgba(255,255,255,0.7);">About</a>
              </li>
              <li style="margin-bottom: 0.5rem;">
                <a href="/careers" style="color: rgba(255,255,255,0.7);">Careers</a>
              </li>
              <li style="margin-bottom: 0.5rem;">
                <a href="/press" style="color: rgba(255,255,255,0.7);">Press</a>
              </li>
            </ul>
          </div>

          <div>
            <h4 style="color: var(--sqowe-light-purple); margin-bottom: 1rem;">Resources</h4>
            <ul style="list-style: none; padding: 0;">
              <li style="margin-bottom: 0.5rem;">
                <a href="/blog" style="color: rgba(255,255,255,0.7);">Blog</a>
              </li>
              <li style="margin-bottom: 0.5rem;">
                <a href="/docs" style="color: rgba(255,255,255,0.7);">Documentation</a>
              </li>
              <li style="margin-bottom: 0.5rem;">
                <a href="/support" style="color: rgba(255,255,255,0.7);">Support</a>
              </li>
            </ul>
          </div>

          <div>
            <h4 style="color: var(--sqowe-light-purple); margin-bottom: 1rem;">Legal</h4>
            <ul style="list-style: none; padding: 0;">
              <li style="margin-bottom: 0.5rem;">
                <a href="/privacy" style="color: rgba(255,255,255,0.7);">Privacy</a>
              </li>
              <li style="margin-bottom: 0.5rem;">
                <a href="/terms" style="color: rgba(255,255,255,0.7);">Terms</a>
              </li>
              <li style="margin-bottom: 0.5rem;">
                <a href="/cookies" style="color: rgba(255,255,255,0.7);">Cookies</a>
              </li>
            </ul>
          </div>
        </div>

        <div
          style="margin-top: 3rem; padding-top: 2rem; border-top: 1px solid rgba(255,255,255,0.1); text-align: center; color: rgba(255,255,255,0.5);"
        >
          <p>&copy; 2024 sqowe. All rights reserved.</p>
        </div>
      </div>
    </footer>
  </body>
</html>
```

---

## 9. Responsive Design Guidelines

### 9.1 Breakpoints

```css
:root {
  --breakpoint-xs: 480px;
  --breakpoint-sm: 640px;
  --breakpoint-md: 768px;
  --breakpoint-lg: 1024px;
  --breakpoint-xl: 1280px;
  --breakpoint-2xl: 1536px;
}

/* Mobile First Approach */
/* Base styles: Mobile (< 768px) */

@media (min-width: 768px) {
  /* Tablet styles */
}

@media (min-width: 1024px) {
  /* Desktop styles */
}

@media (min-width: 1280px) {
  /* Large desktop styles */
}
```

### 9.2 Responsive Typography

```css
/* Fluid typography */
h1 {
  font-size: clamp(2rem, 5vw, 3.5rem);
}

h2 {
  font-size: clamp(1.5rem, 4vw, 2.25rem);
}

h3 {
  font-size: clamp(1.25rem, 3vw, 1.875rem);
}

body {
  font-size: clamp(0.875rem, 2vw, 1rem);
}
```

### 9.3 Grid Utilities

```css
.grid {
  display: grid;
  gap: var(--space-xl);
}

.grid-2 {
  grid-template-columns: 1fr;
}

.grid-3 {
  grid-template-columns: 1fr;
}

.grid-4 {
  grid-template-columns: 1fr;
}

@media (min-width: 768px) {
  .grid-2 {
    grid-template-columns: repeat(2, 1fr);
  }

  .grid-3 {
    grid-template-columns: repeat(2, 1fr);
  }

  .grid-4 {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (min-width: 1024px) {
  .grid-3 {
    grid-template-columns: repeat(3, 1fr);
  }

  .grid-4 {
    grid-template-columns: repeat(4, 1fr);
  }
}
```

---

## 10. Accessibility Guidelines

### 10.1 Color Contrast

- Ensure minimum contrast ratio of 4.5:1 for normal text
- Ensure minimum contrast ratio of 3:1 for large text (18pt+)
- Use the approved color combinations that meet WCAG AA standards

**Approved Combinations:**

- Dark Ground (#222222) with white text ✓
- Dark Purple (#5B5377) with white text ✓
- Light Purple (#8E88A3) with Dark Ground (#222222) ✓
- White background with Dark Ground (#222222) text ✓

### 10.2 Focus States

```css
*:focus {
  outline: 2px solid var(--sqowe-light-purple);
  outline-offset: 2px;
}

*:focus:not(:focus-visible) {
  outline: none;
}

*:focus-visible {
  outline: 2px solid var(--sqowe-light-purple);
  outline-offset: 2px;
}
```

### 10.3 Skip Links

```html
<a href="#main-content" class="skip-link"> Skip to main content </a>

<main id="main-content">
  <!-- Main content here -->
</main>
```

```css
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  background: var(--sqowe-dark-purple);
  color: white;
  padding: 8px;
  text-decoration: none;
  z-index: 100;
}

.skip-link:focus {
  top: 0;
}
```

### 10.4 ARIA Labels

```html
<!-- Navigation -->
<nav aria-label="Main navigation">
  <ul>
    <li><a href="/" aria-current="page">Home</a></li>
    <li><a href="/about">About</a></li>
  </ul>
</nav>

<!-- Buttons with icons -->
<button aria-label="Close dialog">
  <span aria-hidden="true">&times;</span>
</button>

<!-- Form inputs -->
<label for="email">Email Address</label>
<input type="email" id="email" name="email" aria-required="true" aria-describedby="email-help" />
<span id="email-help">We'll never share your email</span>
```

---

## 11. Performance Optimization

### 11.1 CSS Best Practices

```css
/* Use CSS containment */
.card {
  contain: layout style paint;
}

/* Optimize animations */
.btn {
  will-change: transform;
  transition: transform 0.3s ease;
}

.btn:hover {
  transform: translateY(-2px);
}

/* Use CSS Grid instead of floats */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}
```

### 11.2 Image Optimization

```html
<!-- Use responsive images -->
<img
  srcset="image-320w.jpg 320w, image-640w.jpg 640w, image-1280w.jpg 1280w"
  sizes="(max-width: 768px) 100vw, 50vw"
  src="image-640w.jpg"
  alt="Description"
  loading="lazy"
/>

<!-- Use WebP with fallback -->
<picture>
  <source srcset="image.webp" type="image/webp" />
  <source srcset="image.jpg" type="image/jpeg" />
  <img src="image.jpg" alt="Description" loading="lazy" />
</picture>
```

### 11.3 Font Loading

```css
/* Optimize font loading */
@font-face {
  font-family: 'Montserrat';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/montserrat-regular.woff2') format('woff2');
}
```

---

## 12. Quality Checklist

### Before Launch:

- [ ] All colors match brand guidelines
- [ ] Montserrat font is properly loaded
- [ ] Logo variants are correctly used based on background
- [ ] Responsive design works on mobile, tablet, and desktop
- [ ] All interactive elements have hover states
- [ ] Focus states are visible for keyboard navigation
- [ ] Color contrast meets WCAG AA standards
- [ ] Forms have proper labels and validation
- [ ] Images have alt text
- [ ] Page loads in under 3 seconds
- [ ] CSS is minified for production
- [ ] All links are working
- [ ] Site is tested in Chrome, Firefox, Safari, and Edge

---

## 13. Common Mistakes to Avoid

**DON'T:**

1. Use colors outside the approved palette
2. Use fonts other than Montserrat
3. Stretch or distort the logo
4. Use low contrast text combinations
5. Ignore mobile responsiveness
6. Forget to add hover states to interactive elements
7. Use inline styles extensively (use CSS classes)
8. Create pixel-perfect designs that don't scale
9. Ignore accessibility requirements
10. Over-animate elements (keep it subtle and purposeful)

**DO:**

1. Follow the established color system
2. Use Montserrat font family consistently
3. Maintain logo clear space and sizing
4. Ensure readable contrast ratios
5. Design mobile-first
6. Add smooth transitions to interactive elements
7. Use CSS variables for maintainability
8. Create flexible, responsive layouts
9. Include ARIA labels and semantic HTML
10. Test on real devices and browsers

---

## 14. Resources

### Design Files

- Brand Guidelines PDF
- Logo files (SVG, PNG formats)
- Color swatches
- Typography specimens

### Tools

- **Google Fonts**: https://fonts.google.com/specimen/Montserrat
- **Color Contrast Checker**: https://webaim.org/resources/contrastchecker/
- **CSS Variables Generator**: Custom CSS variables for the brand
- **Accessibility Checker**: WAVE or axe DevTools

### Documentation

- MDN Web Docs: https://developer.mozilla.org/
- React Documentation: https://react.dev/
- CSS Grid Guide: https://css-tricks.com/snippets/css/complete-guide-grid/
- WCAG Guidelines: https://www.w3.org/WAI/WCAG21/quickref/

---

## 15. Support

For questions about brand guidelines or implementation:

- Review the original Brand Guidelines PDF
- Check this document for technical implementation details
- Test all implementations across different devices and browsers
- Maintain consistency across all digital properties

---

**Document Version:** 1.0  
**Last Updated:** December 2024  
**Based on:** sqowe Corporate Brand Guidelines

---

_This guide is meant to be a living document. Update it as the brand evolves and new patterns emerge._
