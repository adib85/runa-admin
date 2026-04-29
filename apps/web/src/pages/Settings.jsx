import { useAuth } from '../context/AuthContext';

export default function Settings() {
  const { user } = useAuth();

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">Profile</h1>
        <p className="page-subtitle">Manage your account and preferences</p>
      </div>

      {/* Profile Section */}
      <section className="mb-12">
        <h2 className="section-title">Profile</h2>
        <div className="border border-neutral-100 p-8">
          <div className="max-w-md space-y-6">
            <div>
              <label className="label">Name</label>
              <input
                type="text"
                className="input"
                defaultValue={user?.name}
                placeholder="Your name"
              />
            </div>
            <div>
              <label className="label">Email</label>
              <input
                type="email"
                className="input"
                defaultValue={user?.email}
                disabled
              />
              <p className="text-xs text-neutral-400 mt-2">Email cannot be changed</p>
            </div>
            <button className="btn btn-primary">
              Save Changes
            </button>
          </div>
        </div>
      </section>

      {/* Delete Account */}
      <section className="mt-8 max-w-md">
        <p className="text-sm text-neutral-900 mb-1">Delete account</p>
        <p className="text-xs text-neutral-500 mb-3">
          Requesting account deletion will send an email to our team. Your account and all associated data will be permanently deleted within 7 days.
        </p>
        <button className="text-xs text-red-600 hover:text-red-700 underline">
          Request account deletion
        </button>
      </section>
    </div>
  );
}
