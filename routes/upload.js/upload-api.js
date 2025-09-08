# File Upload API for Convert Pro

```javascript
// app/api/upload/route.js

import { NextRequest, NextResponse } from 'next/server';
import { validateFile, basicVirusScan } from '@/middleware/fileValidation';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

// Configure upload directory
const UPLOAD_DIR = path.join(process.cwd(), 'temp', 'uploads');

// Ensure upload directory exists
async function ensureUploadDir() {
  try {
    await fs.access(UPLOAD_DIR);
  } catch {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  }
}

/**
 * POST /api/upload
 * Handle file upload with validation and security
 */
export async function POST(request) {
  try {
    // Ensure upload directory exists
    await ensureUploadDir();
    
    // Get user authentication status
    const supabase = createClientComponentClient();
    const { data: { user } } = await supabase.auth.getUser();
    
    // Parse form data
    const formData = await request.formData();
    const file = formData.get('file');
    
    if (!file || !file.size) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // Convert file to buffer
    const buffer = Buffer.from(await file.arrayBuffer());
    
    // Determine user plan (free/pro)
    const userPlan = user?.user_metadata?.plan || 'free';
    
    // Validate file
    const validation = await validateFile(buffer, file.name, userPlan);
    
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      );
    }
    
    // Basic security scan
    await basicVirusScan(buffer);
    
    // Check daily usage limits for free users
    if (userPlan === 'free') {
      const dailyUsage = await checkDailyUsage(user?.id);
      if (dailyUsage >= 20) {
        return NextResponse.json(
          { error: 'Daily limit reached. Upgrade to Pro for unlimited conversions.' },
          { status: 429 }
        );
      }
    }
    
    // Generate unique file ID
    const fileId = crypto.randomUUID();
    
    // Save file temporarily
    const tempFilePath = path.join(UPLOAD_DIR, validation.secureFileName);
    await fs.writeFile(tempFilePath, buffer);
    
    // Save file metadata to database
    const fileMetadata = {
      id: fileId,
      user_id: user?.id || null,
      original_name: validation.originalName,
      secure_name: validation.secureFileName,
      category: validation.category,
      size: validation.size,
      mime_type: validation.mimeType,
      file_hash: validation.hash,
      temp_path: tempFilePath,
      supported_outputs: validation.supportedOutputs,
      uploaded_at: new Date().toISOString(),
      status: 'uploaded'
    };
    
    // Store in Supabase
    const { data: dbResult, error: dbError } = await supabase
      .from('file_uploads')
      .insert([fileMetadata])
      .select()
      .single();
      
    if (dbError) {
      // Clean up temp file if database save fails
      await fs.unlink(tempFilePath).catch(console.error);
      console.error('Database error:', dbError);
      return NextResponse.json(
        { error: 'Failed to save file metadata' },
        { status: 500 }
      );
    }
    
    // Update usage tracking
    if (user?.id) {
      await updateUsageTracking(user.id, validation.size);
    }
    
    // Return success response
    return NextResponse.json({
      success: true,
      fileId,
      fileInfo: {
        originalName: validation.originalName,
        category: validation.category,
        size: validation.size,
        sizeFormatted: validation.sizeFormatted,
        supportedOutputs: validation.supportedOutputs
      },
      message: 'File uploaded successfully'
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Upload failed. Please try again.' },
      { status: 500 }
    );
  }
}

/**
 * Check user's daily usage
 */
async function checkDailyUsage(userId) {
  if (!userId) return 0;
  
  const supabase = createClientComponentClient();
  const today = new Date().toISOString().split('T')[0];
  
  const { data, error } = await supabase
    .from('file_uploads')
    .select('id')
    .eq('user_id', userId)
    .gte('uploaded_at', `${today}T00:00:00.000Z`)
    .lt('uploaded_at', `${today}T23:59:59.999Z`);
    
  if (error) {
    console.error('Usage check error:', error);
    return 0;
  }
  
  return data?.length || 0;
}

/**
 * Update usage tracking
 */
async function updateUsageTracking(userId, fileSize) {
  const supabase = createClientComponentClient();
  const today = new Date().toISOString().split('T')[0];
  
  // Update or insert daily usage record
  const { data: existing } = await supabase
    .from('user_usage')
    .select('*')
    .eq('user_id', userId)
    .eq('date', today)
    .single();
    
  if (existing) {
    // Update existing record
    await supabase
      .from('user_usage')
      .update({
        files_processed: existing.files_processed + 1,
        bytes_processed: existing.bytes_processed + fileSize,
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id);
  } else {
    // Create new record
    await supabase
      .from('user_usage')
      .insert([{
        user_id: userId,
        date: today,
        files_processed: 1,
        bytes_processed: fileSize,
        created_at: new Date().toISOString()
      }]);
  }
}

/**
 * GET /api/upload (for testing)
 */
export async function GET() {
  return NextResponse.json({
    message: 'Convert Pro Upload API',
    supportedFormats: {
      images: 'JPG, PNG, GIF, WebP, SVG, TIFF, BMP',
      documents: 'PDF, DOCX, DOC, TXT, RTF, ODT', 
      audio: 'MP3, WAV, FLAC, M4A, AAC, OGG, WMA',
      video: 'MP4, AVI, MOV, MKV, WebM, FLV, 3GP',
      archives: 'ZIP, RAR, 7Z, TAR, GZ'
    },
    limits: {
      free: '2GB per file, 20 files per day',
      pro: '100GB per file, unlimited'
    }
  });
}
```

## Required Database Tables (Supabase):

```sql
-- File uploads table
CREATE TABLE file_uploads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  secure_name TEXT NOT NULL,
  category TEXT NOT NULL,
  size BIGINT NOT NULL,
  mime_type TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  supported_outputs TEXT[],
  uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status TEXT DEFAULT 'uploaded',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Usage tracking table  
CREATE TABLE user_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  files_processed INTEGER DEFAULT 0,
  bytes_processed BIGINT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- Indexes for better performance
CREATE INDEX idx_file_uploads_user_id ON file_uploads(user_id);
CREATE INDEX idx_file_uploads_uploaded_at ON file_uploads(uploaded_at);
CREATE INDEX idx_user_usage_user_date ON user_usage(user_id, date);
```

## Testing the Upload API:

```javascript
// Frontend usage example
const uploadFile = async (file) => {
  const formData = new FormData();
  formData.append('file', file);
  
  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    
    const result = await response.json();
    
    if (result.success) {
      console.log('File uploaded:', result.fileInfo);
      return result.fileId;
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    console.error('Upload failed:', error);
    throw error;
  }
};
```

This API provides:
- âœ… **File validation** (format, size, security)
- âœ… **User authentication** (Supabase integration)
- âœ… **Usage tracking** (daily limits enforcement)
- âœ… **Security scanning** (basic malware detection)
- âœ… **Metadata storage** (database integration)
- âœ… **Error handling** (comprehensive error responses)
