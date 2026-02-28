import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSuperAdmin } from '../context/SuperAdminContext';
import { api } from '../services/api';

const APP_SERVER_URL = "https://enofvc3o7f.execute-api.us-east-1.amazonaws.com/production/healthiny-app";

export default function AIVisualMerchandiser() {
  const { user } = useAuth();
  const { isSuperAdmin } = useSuperAdmin();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [config, setConfig] = useState({
    // AI Context fields
    optionsContext: "",
    aiWidgetPersonalization: "",
    aiMainPersonalization: "",
    adminWidgetContext: "",
    adminWidgetContextWithProfile: "",
    adminWidgetContextCategory1: "",
    adminWidgetContextWithProfileCategory1: "",
    shopTheLookPromptOutfit: "",
    contextBody: "",
    contextPersonality: "",
    contextChromatic: "",
    contextCategoryPageWidget: "",
    // Show/hide states for sections (saved to DB)
    showContextBody: false,
    showContextPersonality: false,
    showContextChromatic: false,
    showcontextCategoryPageWidget: false,
    showShopTheLookPromptOutfit: false
  });

  // Toggle states for collapsible sections
  const [expandedSections, setExpandedSections] = useState({});
  const [shop, setShop] = useState(null);
  const [originalConfig, setOriginalConfig] = useState(null);
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
              ...chatConfig
            }));
            setOriginalConfig(chatConfig);
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

  const toggleSection = (section) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  // Check if context fields have changed (triggers regeneration warning)
  const hasContextChanged = () => {
    if (!originalConfig) return false;

    return (
      config.aiWidgetPersonalization !== originalConfig.aiWidgetPersonalization ||
      config.adminWidgetContext !== originalConfig.adminWidgetContext ||
      config.adminWidgetContextWithProfile !== originalConfig.adminWidgetContextWithProfile ||
      config.adminWidgetContextCategory1 !== originalConfig.adminWidgetContextCategory1 ||
      config.adminWidgetContextWithProfileCategory1 !== originalConfig.adminWidgetContextWithProfileCategory1 ||
      config.shopTheLookPromptOutfit !== originalConfig.shopTheLookPromptOutfit
    );
  };

  // Extract only the AI instruction params to save
  const extractChatParams = (obj) => {
    return {
      optionsContext: obj.optionsContext,
      aiWidgetPersonalization: obj.aiWidgetPersonalization,
      aiMainPersonalization: obj.aiMainPersonalization,
      adminWidgetContext: obj.adminWidgetContext,
      adminWidgetContextWithProfile: obj.adminWidgetContextWithProfile,
      adminWidgetContextCategory1: obj.adminWidgetContextCategory1,
      adminWidgetContextWithProfileCategory1: obj.adminWidgetContextWithProfileCategory1,
      contextBody: obj.contextBody,
      contextPersonality: obj.contextPersonality,
      contextChromatic: obj.contextChromatic,
      contextCategoryPageWidget: obj.contextCategoryPageWidget,
      showContextBody: obj.showContextBody,
      showContextPersonality: obj.showContextPersonality,
      showContextChromatic: obj.showContextChromatic,
      showcontextCategoryPageWidget: obj.showcontextCategoryPageWidget,
      shopTheLookPromptOutfit: obj.shopTheLookPromptOutfit,
      showShopTheLookPromptOutfit: obj.showShopTheLookPromptOutfit
    };
  };

  const handleSave = async () => {
    if (!shop) {
      alert('No shop configured. Please check your store settings.');
      return;
    }

    // Check for context updates and show warning
    const contextUpdated = hasContextChanged();
    if (contextUpdated) {
      const confirmed = window.confirm(
        "You have modified AI instructions that will trigger regeneration of all outfit recommendations. Do you want to continue?"
      );
      if (!confirmed) {
        return;
      }
    }

    setSaving(true);
    try {
      const chat = extractChatParams(config);
      const contextUpdatedParam = contextUpdated ? 1 : 0;
      const url = `${APP_SERVER_URL}?action=saveUserChat&shop=${shop}&contextUpdated=${contextUpdatedParam}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ chat })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      // Update original config to track future changes
      setOriginalConfig(chat);
      
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
        <h1 className="page-title">AI Visual Merchandiser</h1>
        <p className="page-subtitle">
          Configure AI instructions for visual merchandising and product display
        </p>
      </div>

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
            {/* 1. Widget PDP Prompt 1 */}
            <CollapsibleSection
              title="Widget PDP Prompt 1"
              description="First prompt for product display page widget"
              isOpen={expandedSections.aiWidgetPersonalization}
              onToggle={() => toggleSection('aiWidgetPersonalization')}
            >
              <textarea
                className="input"
                rows={4}
                value={config.aiWidgetPersonalization}
                onChange={(e) => handleChange('aiWidgetPersonalization', e.target.value)}
                placeholder="Enter widget personalization instructions..."
              />
            </CollapsibleSection>

            {/* 2. Widget PDP Prompt 2 */}
            <CollapsibleSection
              title="Widget PDP Prompt 2"
              description="Second prompt for product display page widget"
              isOpen={expandedSections.adminWidgetContext}
              onToggle={() => toggleSection('adminWidgetContext')}
            >
              <textarea
                className="input"
                rows={4}
                value={config.adminWidgetContext}
                onChange={(e) => handleChange('adminWidgetContext', e.target.value)}
                placeholder="Enter widget context without profile..."
              />
            </CollapsibleSection>

            {/* 3. Widget Shop the Look Prompt */}
            <CollapsibleSection
              title="Widget Shop the Look Prompt"
              description="Prompt for shop the look widget"
              isOpen={expandedSections.shopTheLookPromptOutfit}
              onToggle={() => toggleSection('shopTheLookPromptOutfit')}
            >
              <textarea
                className="input"
                rows={4}
                value={config.shopTheLookPromptOutfit}
                onChange={(e) => handleChange('shopTheLookPromptOutfit', e.target.value)}
                placeholder="Enter shop the look prompt instructions..."
              />
            </CollapsibleSection>

          {/* 4. Context Widget with Profile - commented out for now
          <CollapsibleSection
            title="Context Widget with Profile"
            description="Widget context with user profile"
            isOpen={expandedSections.adminWidgetContextWithProfile}
            onToggle={() => toggleSection('adminWidgetContextWithProfile')}
          >
            <textarea
              className="input"
              rows={4}
              value={config.adminWidgetContextWithProfile}
              onChange={(e) => handleChange('adminWidgetContextWithProfile', e.target.value)}
              placeholder="Enter widget context with profile..."
            />
          </CollapsibleSection>
          */}

          {/* 5. Context Widget without Profile Category 1 - commented out for now
          <CollapsibleSection
            title="Context Widget without Profile Category 1"
            description="Widget context without profile for category 1"
            isOpen={expandedSections.adminWidgetContextCategory1}
            onToggle={() => toggleSection('adminWidgetContextCategory1')}
          >
            <textarea
              className="input"
              rows={4}
              value={config.adminWidgetContextCategory1}
              onChange={(e) => handleChange('adminWidgetContextCategory1', e.target.value)}
              placeholder="Enter widget context without profile category 1..."
            />
          </CollapsibleSection>
          */}

          {/* 6. Context Widget with Profile Category 1 - commented out for now
          <CollapsibleSection
            title="Context Widget with Profile Category 1"
            description="Widget context with profile for category 1"
            isOpen={expandedSections.adminWidgetContextWithProfileCategory1}
            onToggle={() => toggleSection('adminWidgetContextWithProfileCategory1')}
          >
            <textarea
              className="input"
              rows={4}
              value={config.adminWidgetContextWithProfileCategory1}
              onChange={(e) => handleChange('adminWidgetContextWithProfileCategory1', e.target.value)}
              placeholder="Enter widget context with profile category 1..."
            />
          </CollapsibleSection>
          */}

          {/* 7. Context Body - commented out for now
          <CollapsibleSection
            title="Context Body"
            description="Body type context instructions"
            isOpen={expandedSections.contextBody}
            onToggle={() => toggleSection('contextBody')}
          >
            <textarea
              className="input"
              rows={4}
              value={config.contextBody}
              onChange={(e) => handleChange('contextBody', e.target.value)}
              placeholder="Enter body context instructions..."
            />
          </CollapsibleSection>
          */}

          {/* 8. Context Personality - commented out for now
          <CollapsibleSection
            title="Context Personality"
            description="Personality context instructions"
            isOpen={expandedSections.contextPersonality}
            onToggle={() => toggleSection('contextPersonality')}
          >
            <textarea
              className="input"
              rows={4}
              value={config.contextPersonality}
              onChange={(e) => handleChange('contextPersonality', e.target.value)}
              placeholder="Enter personality context instructions..."
            />
          </CollapsibleSection>
          */}

          {/* 9. Context Chromatic - commented out for now
          <CollapsibleSection
            title="Context Chromatic"
            description="Color/chromatic context instructions"
            isOpen={expandedSections.contextChromatic}
            onToggle={() => toggleSection('contextChromatic')}
          >
            <textarea
              className="input"
              rows={4}
              value={config.contextChromatic}
              onChange={(e) => handleChange('contextChromatic', e.target.value)}
              placeholder="Enter chromatic context instructions..."
            />
          </CollapsibleSection>
          */}

          {/* 10. Context Category Page Widget - commented out for now
          <CollapsibleSection
            title="Context Category Page Widget"
            description="Instructions for category page widget"
            isOpen={expandedSections.contextCategoryPageWidget}
            onToggle={() => toggleSection('contextCategoryPageWidget')}
          >
            <textarea
              className="input"
              rows={4}
              value={config.contextCategoryPageWidget}
              onChange={(e) => handleChange('contextCategoryPageWidget', e.target.value)}
              placeholder="Enter category page widget instructions..."
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
