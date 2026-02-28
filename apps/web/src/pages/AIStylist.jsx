import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSuperAdmin } from '../context/SuperAdminContext';
import { api } from '../services/api';

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

const DEFAULT_PRIMARY_COLOR = "#7846F3";
const DEFAULT_CHAT_BACKGROUND_COLOR = "#ffffff";
const DEFAULT_SECONDARY_COLOR = "#F2F2F1";

export default function AIStylist() {
  const { user } = useAuth();
  const { isSuperAdmin } = useSuperAdmin();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [shop, setShop] = useState(null);
  const [config, setConfig] = useState({
    name: "AI Stylist",
    description: "Here to answer every query and tailor suggestions, focusing on your needs and preferences.",
    message: "How can I help you today?",
    suggestions: ["", "", ""],
    enableChat: false,
    // Desktop position
    chatWidgetPosition: "right",
    marginBottom: 25,
    marginHorizontal: 25,
    // Mobile position
    mobileChatWidgetPosition: "right",
    mobileMarginBottom: 20,
    mobileMarginHorizontal: 20,
    // Colors
    primaryColor: DEFAULT_PRIMARY_COLOR,
    chatBackgroundColor: DEFAULT_CHAT_BACKGROUND_COLOR,
    secondaryColor: DEFAULT_SECONDARY_COLOR,
    // Floating button
    chatFloatingButtonDescription: "Hi there 👋 What brings you to our store today?",
    // Chat prompts
    customContext: "",
    chatPrompt1: "",
    chatPrompt2: "",
    chatPrompt3: ""
  });
  
  // Toggle states for collapsible sections
  const [expandedSections, setExpandedSections] = useState({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const response = await api.get('/stores');
      const stores = response.data?.stores || [];
      const store = stores[0];
      
      let shopName = response.data?.shop || user?.shop || store?.shop || store?.domain;
      
      if (shopName) {
        setShop(shopName);
        
        const url = `${APP_SERVER_URL}?action=getUser&shop=${shopName}`;
        const userResponse = await fetch(url);
        if (userResponse.ok) {
          const userData = await userResponse.json();
          if (userData.data?.chat) {
            const chatConfig = userData.data.chat;
            setConfig(prev => ({
              ...prev,
              name: chatConfig.name || prev.name,
              description: chatConfig.description || prev.description,
              message: chatConfig.message || prev.message,
              suggestions: chatConfig.suggestions || prev.suggestions,
              enableChat: chatConfig.enableChat || prev.enableChat,
              chatWidgetPosition: chatConfig.chatWidgetPosition || prev.chatWidgetPosition,
              marginBottom: chatConfig.marginBottom || prev.marginBottom,
              marginHorizontal: chatConfig.marginHorizontal || prev.marginHorizontal,
              mobileChatWidgetPosition: chatConfig.mobileChatWidgetPosition || prev.mobileChatWidgetPosition,
              mobileMarginBottom: chatConfig.mobileMarginBottom || prev.mobileMarginBottom,
              mobileMarginHorizontal: chatConfig.mobileMarginHorizontal || prev.mobileMarginHorizontal,
              primaryColor: chatConfig.primaryColor || prev.primaryColor,
              chatBackgroundColor: chatConfig.chatBackgroundColor || prev.chatBackgroundColor,
              secondaryColor: chatConfig.secondaryColor || prev.secondaryColor,
              chatFloatingButtonDescription: chatConfig.chatFloatingButtonDescription || prev.chatFloatingButtonDescription,
              customContext: chatConfig.customContext || prev.customContext,
              chatPrompt1: chatConfig.chatPrompt1 || prev.chatPrompt1,
              chatPrompt2: chatConfig.chatPrompt2 || prev.chatPrompt2,
              chatPrompt3: chatConfig.chatPrompt3 || prev.chatPrompt3
            }));
          }
        }
      }
    } catch (error) {
      console.error('Error loading config:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  const handleSuggestionChange = (index, value) => {
    const newSuggestions = [...config.suggestions];
    newSuggestions[index] = value;
    setConfig(prev => ({ ...prev, suggestions: newSuggestions }));
  };

  const toggleSection = (section) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const restoreDefaultColors = () => {
    setConfig(prev => ({
      ...prev,
      primaryColor: DEFAULT_PRIMARY_COLOR,
      chatBackgroundColor: DEFAULT_CHAT_BACKGROUND_COLOR,
      secondaryColor: DEFAULT_SECONDARY_COLOR
    }));
  };

  const handleSave = async () => {
    if (!shop) {
      alert('No shop configured. Please check your store settings.');
      return;
    }

    setSaving(true);
    try {
      // We only save the fields this page manages
      const chatUpdate = {
        name: config.name,
        description: config.description,
        message: config.message,
        suggestions: config.suggestions,
        enableChat: config.enableChat,
        chatWidgetPosition: config.chatWidgetPosition,
        marginBottom: config.marginBottom,
        marginHorizontal: config.marginHorizontal,
        mobileChatWidgetPosition: config.mobileChatWidgetPosition,
        mobileMarginBottom: config.mobileMarginBottom,
        mobileMarginHorizontal: config.mobileMarginHorizontal,
        primaryColor: config.primaryColor,
        chatBackgroundColor: config.chatBackgroundColor,
        secondaryColor: config.secondaryColor,
        chatFloatingButtonDescription: config.chatFloatingButtonDescription,
        customContext: config.customContext,
        chatPrompt1: config.chatPrompt1,
        chatPrompt2: config.chatPrompt2,
        chatPrompt3: config.chatPrompt3
      };

      const url = `${APP_SERVER_URL}?action=saveUserChat&shop=${shop}&contextUpdated=0`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ chat: chatUpdate })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
    } catch (error) {
      console.error('Error saving config:', error);
      alert('Failed to save configuration: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="spinner"></div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Toast */}
      {showToast && (
        <div className="fixed top-4 right-4 bg-neutral-900 text-white px-6 py-3 rounded-sm shadow-lg z-50 animate-fade-in">
          Changes saved successfully
        </div>
      )}

      <div className="page-header">
        <h1 className="page-title">AI Stylist</h1>
        <p className="page-subtitle">
          Configure your AI Stylist assistant settings
        </p>
      </div>

      {/* AI Assistant Display */}
      <section className="mb-8">
        <h2 className="section-title">AI Assistant Display</h2>
        <div className="border border-neutral-100 p-8">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={config.enableChat}
              onChange={(e) => handleChange('enableChat', e.target.checked)}
              className="w-5 h-5 border-neutral-300 text-neutral-900 focus:ring-neutral-900 rounded"
            />
            <div>
              <span className="text-sm font-medium text-neutral-900">Show AI Assistant</span>
              <p className="text-xs text-neutral-500 mt-0.5">
                When enabled, the AI Assistant will be visible to all your users
              </p>
            </div>
          </label>
        </div>
      </section>

      {/* Basic Configuration */}
      <section className="mb-8">
        <h2 className="section-title">AI Assistant Configuration</h2>
        <div className="border border-neutral-100 p-8">
          <div className="max-w-2xl space-y-6">
            {/* Name */}
            <div>
              <label className="label">Name</label>
              <input
                type="text"
                className="input"
                value={config.name}
                onChange={(e) => handleChange('name', e.target.value)}
                placeholder="AI Stylist"
              />
            </div>

            {/* Description */}
            <div>
              <label className="label">Description</label>
              <textarea
                className="input"
                rows={2}
                value={config.description}
                onChange={(e) => handleChange('description', e.target.value)}
                placeholder="Here to answer every query..."
              />
            </div>

            {/* Welcome Message */}
            <div>
              <label className="label">Welcome Message</label>
              <input
                type="text"
                className="input"
                value={config.message}
                onChange={(e) => handleChange('message', e.target.value)}
                placeholder="How can I help you today?"
              />
            </div>

            {/* Welcome Prompts */}
            <div>
              <label className="label">Welcome Prompts</label>
              <div className="space-y-3">
                {config.suggestions.map((suggestion, index) => (
                  <input
                    key={index}
                    type="text"
                    className="input"
                    value={suggestion}
                    onChange={(e) => handleSuggestionChange(index, e.target.value)}
                    placeholder={`Welcome prompt ${index + 1}`}
                  />
                ))}
              </div>
            </div>

            {/* Floating Button Description */}
            <div>
              <label className="label">Chat Floating Button Description</label>
              <textarea
                className="input"
                rows={2}
                value={config.chatFloatingButtonDescription}
                onChange={(e) => handleChange('chatFloatingButtonDescription', e.target.value)}
                placeholder="Hi there 👋 What brings you to our store today?"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Desktop Configuration */}
      <section className="mb-8">
        <h2 className="section-title">Chat Configuration - Desktop</h2>
        <div className="border border-neutral-100 p-8">
          <div className="max-w-2xl space-y-6">
            <div>
              <label className="label">Chat Position</label>
              <select
                className="input"
                value={config.chatWidgetPosition}
                onChange={(e) => handleChange('chatWidgetPosition', e.target.value)}
              >
                <option value="right">Right</option>
                <option value="left">Left</option>
                <option value="center">Center</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Margin Bottom (px)</label>
                <input
                  type="number"
                  className="input"
                  value={config.marginBottom}
                  onChange={(e) => handleChange('marginBottom', parseInt(e.target.value) || 0)}
                />
              </div>
              <div>
                <label className="label">Margin Horizontal (px)</label>
                <input
                  type="number"
                  className="input"
                  value={config.marginHorizontal}
                  onChange={(e) => handleChange('marginHorizontal', parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Mobile Configuration */}
      <section className="mb-8">
        <h2 className="section-title">Chat Configuration - Mobile</h2>
        <div className="border border-neutral-100 p-8">
          <div className="max-w-2xl space-y-6">
            <div>
              <label className="label">Chat Position</label>
              <select
                className="input"
                value={config.mobileChatWidgetPosition}
                onChange={(e) => handleChange('mobileChatWidgetPosition', e.target.value)}
              >
                <option value="right">Right</option>
                <option value="left">Left</option>
                <option value="center">Center</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Margin Bottom (px)</label>
                <input
                  type="number"
                  className="input"
                  value={config.mobileMarginBottom}
                  onChange={(e) => handleChange('mobileMarginBottom', parseInt(e.target.value) || 0)}
                />
              </div>
              <div>
                <label className="label">Margin Horizontal (px)</label>
                <input
                  type="number"
                  className="input"
                  value={config.mobileMarginHorizontal}
                  onChange={(e) => handleChange('mobileMarginHorizontal', parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Color Configuration */}
      <section className="mb-8">
        <h2 className="section-title">Colors</h2>
        <div className="border border-neutral-100 p-8">
          <div className="max-w-2xl space-y-6">
            <div>
              <label className="label">Chat Color</label>
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded border border-neutral-200"
                  style={{ backgroundColor: config.primaryColor }}
                />
                <input
                  type="text"
                  className="input flex-1"
                  value={config.primaryColor}
                  onChange={(e) => handleChange('primaryColor', e.target.value)}
                  placeholder="#7846F3"
                />
                <input
                  type="color"
                  value={config.primaryColor}
                  onChange={(e) => handleChange('primaryColor', e.target.value)}
                  className="w-10 h-10 cursor-pointer border-0"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={restoreDefaultColors}
              className="btn btn-secondary btn-sm"
            >
              Restore Default Colors
            </button>
          </div>
        </div>
      </section>

      {/* Advanced Settings - Superadmin only */}
      {isSuperAdmin && (
        <section className="mb-8">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full flex items-center justify-between py-3"
          >
            <h2 className="section-title mb-0">Advanced Settings</h2>
            <svg
              className={`w-5 h-5 text-neutral-400 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          
          {showAdvanced && (
          <div className="border border-neutral-100 p-8 space-y-6 mt-2">
            <h3 className="text-sm font-medium text-neutral-700 mb-4">Chat Prompts</h3>
            
            {/* Chat Prompt 1 */}
            <CollapsibleSection
              title="Chat Prompt 1"
              description="First chat prompt instructions"
              isOpen={expandedSections.chatPrompt1}
              onToggle={() => toggleSection('chatPrompt1')}
            >
              <textarea
                className="input"
                rows={4}
                value={config.chatPrompt1}
                onChange={(e) => handleChange('chatPrompt1', e.target.value)}
                placeholder="Enter chat prompt 1 instructions..."
              />
            </CollapsibleSection>

            {/* Chat Prompt 2 */}
            <CollapsibleSection
              title="Chat Prompt 2"
              description="Second chat prompt instructions"
              isOpen={expandedSections.chatPrompt2}
              onToggle={() => toggleSection('chatPrompt2')}
            >
              <textarea
                className="input"
                rows={4}
                value={config.chatPrompt2}
                onChange={(e) => handleChange('chatPrompt2', e.target.value)}
                placeholder="Enter chat prompt 2 instructions..."
              />
            </CollapsibleSection>

            {/* Chat Prompt 3 */}
            <CollapsibleSection
              title="Chat Prompt 3"
              description="Third chat prompt instructions"
              isOpen={expandedSections.chatPrompt3}
              onToggle={() => toggleSection('chatPrompt3')}
            >
              <textarea
                className="input"
                rows={4}
                value={config.chatPrompt3}
                onChange={(e) => handleChange('chatPrompt3', e.target.value)}
                placeholder="Enter chat prompt 3 instructions..."
              />
            </CollapsibleSection>

            {/* Context Chat - commented out for now
            <CollapsibleSection
              title="Context Chat"
              description="Custom context for chat conversations"
              isOpen={expandedSections.customContext}
              onToggle={() => toggleSection('customContext')}
            >
              <textarea
                className="input"
                rows={4}
                value={config.customContext}
                onChange={(e) => handleChange('customContext', e.target.value)}
                placeholder="Enter custom context for chat..."
              />
            </CollapsibleSection>
            */}
          </div>
          )}
        </section>
      )}

      {/* Save Button */}
      <div className="flex justify-end gap-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="btn btn-primary"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

function CollapsibleSection({ title, description, isOpen, onToggle, children }) {
  return (
    <div className="border-b border-neutral-100 pb-6 last:border-0 last:pb-0">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between text-left"
      >
        <div>
          <h3 className="text-sm font-medium text-neutral-900">{title}</h3>
          <p className="text-xs text-neutral-500 mt-0.5">{description}</p>
        </div>
        <svg
          className={`w-5 h-5 text-neutral-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && (
        <div className="mt-4">
          {children}
        </div>
      )}
    </div>
  );
}
